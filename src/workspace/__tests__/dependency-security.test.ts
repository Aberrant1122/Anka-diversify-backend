import { spawnSync } from "node:child_process";
import path from "node:path";
import { extractDocumentText } from "../../ai/shared/utils";

// Finite synthetic inputs only. No application startup, provider or database.
describe("patched dependency compatibility", () => {
  it("keeps compressed JSON and response middleware working after trailing compressed bytes", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      const zlib = require('node:zlib');
      const express = require('express');
      const compression = require('compression');
      const app = express();
      app.use(compression({threshold: 0}));
      app.use(express.json({limit:'10mb'}));
      app.post('/', (req,res) => res.json(req.body));
      app.use((err,req,res,next) => res.status(400).json({error:'invalid body'}));
      const server = app.listen(0,'127.0.0.1', async () => {
        const port = server.address().port;
        function request(trailing) {
          return new Promise((resolve,reject) => {
            const req = http.request({host:'127.0.0.1',port,method:'POST',path:'/',headers:{'Content-Type':'application/json','Content-Encoding':'gzip','Accept-Encoding':'gzip'}}, res => {
              const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,encoding:res.headers['content-encoding'],body:Buffer.concat(chunks)}));
            });
            req.on('error',reject);
            req.write(zlib.gzipSync(JSON.stringify({message:'synthetic'})));
            if(trailing) setTimeout(()=>req.end(Buffer.from('invalid trailing bytes')),30);
            else req.end();
          });
        }
        try {
          const first = await request(false);
          assert.equal(first.status,200);assert.equal(first.encoding,'gzip');
          assert.deepEqual(JSON.parse(zlib.gunzipSync(first.body)),{message:'synthetic'});
          const malformed = await request(true);
          assert.ok([200,400].includes(malformed.status));
          await new Promise(resolve=>setTimeout(resolve,80));
          assert.equal((await request(false)).status,200);
          server.close(()=>process.exit(0));
        } catch(error) {console.error(error);server.close(()=>process.exit(1));}
      });
      setTimeout(()=>process.exit(2),4000).unref();
    `], { cwd: path.resolve(__dirname, "../../.."), timeout: 6000, encoding: "utf8" });
    expect({status: child.status, stderr: child.stderr}).toEqual({status: 0, stderr: ""});
  });

  it("keeps mapped IPv6 trust restricted to the configured subnet", () => {
    const proxyaddr = require("proxy-addr");
    const trust = proxyaddr.compile("::ffff:192.0.2.0/120");
    expect(trust("192.0.2.10")).toBe(true);
    expect(trust("::ffff:192.0.2.10")).toBe(true);
    expect(trust("198.51.100.10")).toBe(false);
    expect(trust("::ffff:198.51.100.10")).toBe(false);
    expect(trust("2001:db8::1")).toBe(false);
  });

  it("extracts a synthetic DOCX through the application helper without a provider", async () => {
    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic document</w:t></w:r></w:p></w:body></w:document>');
    const buffer = await zip.generateAsync({type: "nodebuffer"});
    const text = await extractDocumentText([{name:"fixture.docx", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",dataUrl:buffer.toString("base64")}]);
    expect(text).toContain("Synthetic document");
    expect(text).not.toContain("could not extract");
  });
});
// Morgan's global combined formatter handles untrusted HTTP fields.
describe("compatible production residual fixes", () => {
  it("keeps combined logs on one line and escapes field delimiters", () => {
    const morgan = require("morgan");
    const format = morgan.compile(morgan.combined);
    const req = {
      method: "GET", url: "/synthetic", httpVersionMajor: 1, httpVersionMinor: 1,
      connection: {remoteAddress: "127.0.0.1"},
      headers: {"user-agent": 'agent"\\\r\nforged\u2028entry', referer: 'https://example.test/"quoted', authorization: "Basic " + Buffer.from("user\nname:synthetic").toString("base64")},
    };
    const res = {headersSent: true, statusCode: 200, getHeader: () => "0"};
    const line = format(morgan, req, res);
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line).toContain('agent\\"\\\\\\r\\nforged\\u2028entry');
    expect(line).toContain('https://example.test/\\"quoted');
    const benign = format(morgan, {...req, headers: {"user-agent": "synthetic-agent"}}, res);
    expect(benign).toContain('"GET /synthetic HTTP/1.1" 200 0 "-" "synthetic-agent"');
  });

  it("preserves S3 request signing and XML error decoding through an in-memory handler", async () => {
    const {S3Client, DeleteObjectCommand, PutObjectCommand} = require("@aws-sdk/client-s3");
    const {Readable} = require("node:stream");
    const handle = jest.fn()
      .mockResolvedValueOnce({response: {statusCode: 404, headers: {"content-type": "application/xml", "x-amz-request-id": "synthetic-request"}, body: Readable.from([Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>Synthetic &amp; missing</Message><RequestId>synthetic-request</RequestId></Error>')])}})
      .mockResolvedValueOnce({response: {statusCode: 200, headers: {etag: '"synthetic-etag"'}, body: Readable.from([])}});
    const client = new S3Client({region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, maxAttempts: 1, credentials: {accessKeyId: "SYNTHETIC", secretAccessKey: "synthetic-only"}, requestHandler: {handle}});
    try {
      await expect(client.send(new DeleteObjectCommand({Bucket: "synthetic-bucket", Key: "folder/a b&c.txt"}))).rejects.toMatchObject({name: "NoSuchKey", message: "Synthetic & missing", $metadata: {httpStatusCode: 404, requestId: "synthetic-request"}});
      expect(handle.mock.calls[0][0]).toMatchObject({method: "DELETE", path: "/synthetic-bucket/folder/a%20b%26c.txt"});
      expect(handle.mock.calls[0][0].headers.authorization).toContain("AWS4-HMAC-SHA256");
      await expect(client.send(new PutObjectCommand({Bucket: "synthetic-bucket", Key: "fixture.txt", Body: "synthetic"}))).resolves.toMatchObject({ETag: '"synthetic-etag"', $metadata: {httpStatusCode: 200}});
      expect(handle).toHaveBeenCalledTimes(2);
    } finally { client.destroy(); }
  });
});