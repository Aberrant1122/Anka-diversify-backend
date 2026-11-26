import { Router } from 'express';
import { AuthController } from '../controllers/auth-controller';
import { authenticateToken } from '../middleware/auth';

const router = Router();
const authController = new AuthController();

// Signup route
router.post('/signup', (_req, res) => res.status(403).json({ error: 'OWNER_BOOTSTRAP_REQUIRED', message: 'This workspace uses a protected owner account.' }));

// Login route
router.post('/login', authController.login.bind(authController));

// Get profile route
router.get('/profile', authenticateToken, authController.getProfile.bind(authController));

export default router;
