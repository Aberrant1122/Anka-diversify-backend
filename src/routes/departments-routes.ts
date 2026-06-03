import { Router } from 'express';
import { DepartmentsController } from '../controllers/departments-controller';

const router = Router();
const ctrl = new DepartmentsController();

router.get('/', ctrl.list.bind(ctrl));
router.post('/', ctrl.create.bind(ctrl));
router.patch('/:id', ctrl.update.bind(ctrl));
router.delete('/:id', ctrl.remove.bind(ctrl));
router.post('/:id/members', ctrl.addMember.bind(ctrl));
router.delete('/:id/members/:userId', ctrl.removeMember.bind(ctrl));

export default router;
