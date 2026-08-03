# refactor-001: Extract Sprint Validation Logic

## Category: REFACTOR
## Difficulty: medium
## Expected Intent: REFACTOR

## Prompt
```
Refactor the sprint creation and update logic in the sprint service. Extract all date-related validation into a dedicated private validateSprintDates() method. This method should be called from both create and update operations. Do not change any existing behavior.
```

## Acceptance Criteria
- [ ] validateSprintDates() method exists in sprint service
- [ ] Create and update both call this method
- [ ] No behavioral changes
- [ ] TypeScript compiles without errors
- [ ] No new files created (pure refactor)

## Expected Files Modified
- `src/services/sprint-service.ts` only

## Hallucination Signals to Watch
- Creating SprintValidationService as a separate file
- Modifying routes
- Adding new API endpoints
