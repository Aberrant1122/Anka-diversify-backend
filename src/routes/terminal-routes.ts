import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { TERMINAL_DISABLED } from "../config/terminal-policy";

const router = Router({ mergeParams: true });
router.use(authenticateToken);
router.use((_req, res) => {
  res.status(503).json({
    success: false,
    code: TERMINAL_DISABLED,
    error: "Terminal access is unavailable until isolated execution is implemented.",
  });
});
export default router;
