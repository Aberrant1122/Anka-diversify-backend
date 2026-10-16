const http = require("http");

http.get("http://127.0.0.1:3000/development/projects/cp41-journey-project?tab=workflow", (res) => {
  let html = "";
  res.on("data", (c) => (html += c));
  res.on("end", () => {
    const regex = /<script\b[^>]*src="([^"]+)"[^>]*>/g;
    let match;
    let count = 0;
    while ((match = regex.exec(html)) !== null) {
      console.log(count++, match[1]);
    }
  });
});
