import { Router } from 'express';
import { AdminController } from '../controllers/admin-controller';

const router = Router();
const adminController = new AdminController();

// Dashboard stats
router.get('/stats', adminController.getDashboardStats.bind(adminController));

// Invite user route
router.post('/invite-user', adminController.inviteUser.bind(adminController));

// Reset password route
router.post('/reset-password', adminController.resetPassword.bind(adminController));

export default router;
