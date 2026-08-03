# feature-001: Add a "Mark All Tasks Complete" Button

## Category: FEATURE_ADD
## Difficulty: simple
## Expected Intent: FEATURE_ADD

## Prompt
```
Add a "Mark All Tasks Complete" button to the project tasks page. When clicked, it should set all tasks in the current project to status "done". The button should be in the top-right of the task list header. Wire it to a new PATCH /api/projects/:projectId/tasks/complete-all backend endpoint.
```

## Acceptance Criteria
- [ ] New button exists in the task list UI
- [ ] PATCH endpoint exists at /api/projects/:projectId/tasks/complete-all
- [ ] Endpoint updates all tasks in the project to status="done"
- [ ] No orphan files created
- [ ] TypeScript compiles without errors

## Expected Files Modified
- `app/projects/[id]/tasks/page.tsx` OR any task list component
- `src/routes/project-routes.ts` OR similar
- `src/controllers/project-controller.ts` OR similar

## Hallucination Signals to Watch
- Creating non-existing services (e.g., TaskBulkService)
- Wrong Prisma model field names (correct: `status`, not `taskStatus`)
- Importing components that don't exist
