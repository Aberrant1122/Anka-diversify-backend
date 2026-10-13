import { Router } from "express";
import { LiveBriefController } from "../controllers/live-brief-controller";

const router = Router({ mergeParams: true });
const controller = new LiveBriefController();

router.get("/", controller.get.bind(controller));
router.post("/initialize", controller.initialize.bind(controller));
router.post("/chat", controller.chat.bind(controller));
router.put("/revision", controller.update.bind(controller));
router.post("/claims/:claimId/decision", controller.decideClaim.bind(controller));
router.post("/questions/:questionId/answer", controller.answerQuestion.bind(controller));
router.post("/contradictions/:contradictionId/resolve", controller.resolveContradiction.bind(controller));
router.post("/confirm", controller.confirm.bind(controller));

export default router;
