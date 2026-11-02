import { healthCheck } from "../health-controller";
import { prisma } from "../../services/database";
jest.mock("../../services/database", () => ({ prisma: { $queryRaw: jest.fn(), workspaceHead:{findFirst:jest.fn()}, workspaceOperation:{findFirst:jest.fn()} } }));

it.each([true, false])("database availability %s controls health status", async (available) => {
  const query = prisma.$queryRaw as jest.Mock;
  if (available) query.mockResolvedValueOnce([{ result: 1 }]);
  else query.mockRejectedValueOnce(new Error("private connection details"));
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await healthCheck({} as any, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: available ? "OK" : "UNAVAILABLE" }));
  if (!available) expect(res.status).toHaveBeenCalledWith(503);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain("private connection details");
});
it('does not report ready when the required authority schema is unavailable',async()=>{
  (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([{result:1}]);
  (prisma.workspaceHead.findFirst as jest.Mock).mockRejectedValueOnce(new Error('missing migration details'));
  const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()};
  await healthCheck({} as any,res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({status:'UNAVAILABLE'});
});
