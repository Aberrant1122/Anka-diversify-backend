# feature-002: Add Project Progress Bar to Dashboard

## Category: FEATURE_ADD
## Difficulty: simple
## Expected Intent: FEATURE_ADD

## Prompt
```
Add a progress bar to each project card on the main dashboard. It should display the project's progress field (0-100). Use a visual bar, not just a number. Style it to match the existing card design.
```

## Acceptance Criteria
- [ ] Progress bar visible on project cards
- [ ] Progress value sourced from project.progress field
- [ ] TypeScript compiles without errors
- [ ] No unused imports

## Expected Files Modified
- Any component rendering project cards on the dashboard

## Hallucination Signals to Watch
- Creating a ProgressService
- Inventing a new API endpoint for progress (already on project model)
- Using a non-installed library
