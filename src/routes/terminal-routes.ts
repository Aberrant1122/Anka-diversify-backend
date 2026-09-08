import { Router } from "express";
import { TerminalController } from "../controllers/terminal-controller";

const router = Router({ mergeParams: true });
const controller = new TerminalController();

router.post("/sessions", controller.createSession);
router.get("/sessions/:sessionId", controller.getSession);
router.post("/sessions/:sessionId/command", controller.runCommand);
router.post("/sessions/:sessionId/interrupt", controller.interruptSession);
router.delete("/sessions/:sessionId", controller.closeSession);

export default router;
