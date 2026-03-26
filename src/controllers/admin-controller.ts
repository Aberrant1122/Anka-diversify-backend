import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../services/database';
import { User } from '../types';

export class AdminController {
  async inviteUser(req: Request, res: Response) {
    try {
      const { email, name } = req.body;

      if (!email || !name) {
        return res.status(400).json({ message: 'Email and name are required' });
      }

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email }
      });

      if (existingUser) {
        return res.status(400).json({ message: 'User with this email already exists' });
      }

      // Generate temporary password
      const tempPassword = Math.random().toString(36).slice(-8);
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(tempPassword, saltRounds);

      // Create user with temporary password
      const user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
        }
      });

      res.status(201).json({
        message: 'User invited successfully',
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          tempPassword, // Only send to admin
          createdAt: user.createdAt
        }
      });
    } catch (error) {
      console.error('Invite user error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async resetPassword(req: Request, res: Response) {
    try {
      const { email, newPassword } = req.body;

      if (!email || !newPassword) {
        return res.status(400).json({ message: 'Email and new password are required' });
      }

      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      });

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
