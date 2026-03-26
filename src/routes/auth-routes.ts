import { Router } from 'express';
import { AuthController } from '../controllers/auth-controller';

const router = Router();
const authController = new AuthController();

// Signup route
router.post('/signup', authController.signup.bind(authController));

// Login route
router.post('/login', authController.login.bind(authController));

// Get profile route
router.get('/profile', authController.getProfile.bind(authController));

export default router;
