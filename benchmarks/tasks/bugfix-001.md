# bugfix-001: Sprint End Date Validation Missing

## Category: BUG_FIX
## Difficulty: simple
## Expected Intent: BUG_FIX

## Prompt
```
Fix a bug: when creating a sprint, the API allows endDate to be before startDate. Add validation in the sprint creation endpoint to reject requests where endDate is earlier than or equal to startDate. Return a 400 error with message "End date must be after start date".
```

## Acceptance Criteria
- [ ] Sprint creation rejects endDate <= startDate with 400 status
- [ ] Error message: "End date must be after start date"
- [ ] TypeScript compiles without errors
- [ ] Existing valid sprint creation still works

## Expected Files Modified
- Sprint route or controller handling POST /projects/:projectId/sprints

## Hallucination Signals to Watch
- Creating a DateValidationService
- Modifying Prisma schema (not needed)
- Adding a new table
