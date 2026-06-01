import { Router } from 'express';
import { RulesController } from '../controllers/rules-controller';

const router = Router();
const ctrl = new RulesController();

router.get('/', ctrl.list.bind(ctrl));
router.post('/', ctrl.create.bind(ctrl));
router.patch('/:id', ctrl.update.bind(ctrl));
router.delete('/:id', ctrl.remove.bind(ctrl));
router.post('/:id/duplicate', ctrl.duplicate.bind(ctrl));
router.post('/:id/run', ctrl.run.bind(ctrl));

export default router;
