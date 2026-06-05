# Per-Project GitHub Token Setup

## Overview

This system implements secure, per-project GitHub Personal Access Tokens (PAT) for seamless AI-driven code commits and repository operations. Each project stores its own encrypted token, enabling multi-user workflows without hardcoding credentials.

## ✅ Features

- **Production-ready**: No hardcoded tokens in environment files
- **Quick to implement**: ~30 minutes vs 3-4 hours for OAuth
- **Multi-user safe**: Each user can use their own token per project
- **Flexible**: Different tokens for different projects if needed
- **Secure**: Tokens encrypted with AES-256-CBC in database
- **Simple UX**: Just paste token once during project creation
- **No external dependencies**: No OAuth complexity
- **Easy to upgrade**: Can add OAuth in future if needed

## Architecture

### Backend Components

1. **Database Model** (`prisma/schema.prisma`)
   - `githubToken` field added to `Project` model (encrypted string)

2. **Encryption Utilities** (`src/utils/encryption.ts`)
   - AES-256-CBC encryption/decryption
   - GitHub token validation via API
   - Secure key management

3. **API Endpoints** (`src/routes/project-routes.ts`)
   - `POST /projects` - Create project with token (required)
   - `PUT /projects/:id/github-token` - Update token
   - `POST /projects/validate-github-token` - Validate token

4. **GitHub Service** (`src/services/github.service.ts`)
   - Updated to accept optional token parameter
   - Falls back to global token if project token not available
   - All GitHub API calls support per-project tokens

### Frontend Components

1. **Project Creation Dialog** (`components/project/ProjectsHeader.tsx`)
   - GitHub token input field (required)
   - Real-time token validation
   - Visual feedback (valid/invalid/validating)
   - Show/hide token toggle
   - Link to create GitHub token

2. **Project API** (`lib/project-api.ts`)
   - `validateGitHubToken()` - Validate token before submission
   - `updateGitHubToken()` - Update token for existing project
   - `create()` - Include token in project creation

## Setup Instructions

### 1. Environment Configuration

Add encryption key to your `.env` file:

```env
# Encryption for sensitive data (GitHub tokens, etc.)
ENCRYPTION_KEY=your_32_character_encryption_key_here_change_this_in_production
```

**Generate a secure key:**
```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex').slice(0, 32))"

# Using OpenSSL
openssl rand -base64 32 | cut -c1-32
```

⚠️ **Important**: 
- Use a different key in production
- Never commit the actual key to version control
- Keep the key secure and backed up

### 2. Database Migration

The migration has already been applied. To verify:

```bash
cd anka-os-backend
npx prisma migrate status
```

### 3. Create a GitHub Personal Access Token

Users need to create their own GitHub PAT:

1. Go to [GitHub Token Settings](https://github.com/settings/tokens/new?scopes=repo)
2. Set token name: "Anka OS - [Project Name]"
3. Select scopes:
   - ✅ `repo` (Full control of private repositories)
     - `repo:status`
     - `repo_deployment`
     - `public_repo`
     - `repo:invite`
4. Set expiration (recommended: 90 days or No expiration for dev)
5. Click "Generate token"
6. Copy the token (format: `ghp_xxxxxxxxxxxxxxxxxxxx`)

### 4. Using the Token

**During Project Creation:**
1. Fill in project details
2. Enter GitHub repository URL
3. Paste the GitHub token
4. System validates token automatically
5. Click "Add Project" (disabled until token is valid)

**For Existing Projects:**
```typescript
// Update token via API
await projectApi.updateGitHubToken(projectId, newToken);
```

## Security Considerations

### Encryption

- Uses AES-256-CBC (industry standard)
- Random IV for each encryption (stored with ciphertext)
- Tokens are decrypted only when needed for GitHub operations
- Never returned in API responses

### Token Validation

- Validates token with GitHub API before storing
- Checks token permissions and scopes
- Returns username for verification
- Prevents invalid tokens from being saved

### Best Practices

1. **Token Rotation**: Encourage users to rotate tokens periodically
2. **Minimum Permissions**: Only request `repo` scope, nothing more
3. **Token Expiration**: Use expiring tokens when possible
4. **Audit Trail**: Log token usage (not the token itself)
5. **Backup Key**: Keep encryption key in secure backup

## API Documentation

### Validate GitHub Token

**Endpoint:** `POST /api/projects/validate-github-token`

**Request:**
```json
{
  "githubToken": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "username": "octocat",
    "scopes": ["repo"]
  }
}
```

**Response (Invalid):**
```json
{
  "success": false,
  "error": "Invalid token or token expired"
}
```

### Create Project with Token

**Endpoint:** `POST /api/projects`

**Request:**
```json
{
  "name": "My Project",
  "description": "Project description",
  "phase": "development",
  "priority": "high",
  "githubUrl": "https://github.com/username/repo",
  "githubToken": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "proj_123",
    "name": "My Project",
    "githubUrl": "https://github.com/username/repo",
    // Note: githubToken is NOT returned
    ...
  }
}
```

### Update Project Token

**Endpoint:** `PUT /api/projects/:id/github-token`

**Request:**
```json
{
  "githubToken": "ghp_newtoken_xxxxxxxxxxxxxxxxxxxx"
}
```

**Response:**
```json
{
  "success": true,
  "message": "GitHub token updated successfully",
  "data": {
    "username": "octocat",
    "scopes": ["repo"]
  }
}
```

## Troubleshooting

### Token Validation Fails

**Issue**: "Invalid token or token expired"

**Solutions:**
1. Verify token is copied correctly (no extra spaces)
2. Check token hasn't expired
3. Ensure token has `repo` scope
4. Regenerate token if necessary

### Encryption Errors

**Issue**: "Failed to encrypt/decrypt data"

**Solutions:**
1. Verify `ENCRYPTION_KEY` is set in `.env`
2. Ensure key is at least 32 characters
3. Don't change the key after encrypting data (tokens will be unrecoverable)

### GitHub API Rate Limits

**Issue**: "GitHub API rate limit exceeded"

**Solutions:**
1. Use authenticated requests (tokens provide 5000 req/hour vs 60 unauthenticated)
2. Implement caching for repo snapshots
3. Add retry logic with exponential backoff

## Migration from Global Token

If you have existing projects using the global `GITHUB_TOKEN`:

1. Projects without `githubToken` will fall back to global token
2. Gradually update projects with user-specific tokens
3. Eventually remove global token from `.env`

```typescript
// Service automatically handles fallback
const token = project.githubToken 
  ? decrypt(project.githubToken) 
  : process.env.GITHUB_TOKEN;
```

## Future Enhancements

### Phase 2: OAuth Integration
- GitHub OAuth flow for token generation
- Automatic token refresh
- Better user experience
- No manual token copying

### Phase 3: Token Management
- Token expiration warnings
- Token rotation reminders
- Usage analytics per token
- Revocation handling

### Phase 4: Advanced Features
- Multiple tokens per project (different permissions)
- Team-level token sharing
- Token inheritance in project templates
- Integration with secret managers (AWS Secrets, Vault)

## Testing

### Manual Testing Checklist

- [ ] Create project with valid token
- [ ] Create project with invalid token (should fail)
- [ ] Create project without token (should fail if GitHub URL provided)
- [ ] Update token for existing project
- [ ] Token validation shows correct feedback
- [ ] AI agent can push changes to repo
- [ ] Token not visible in API responses
- [ ] Token persists after server restart

### Automated Tests

```bash
# Run backend tests
cd anka-os-backend
npm test

# Test encryption/decryption
npm run test:encryption

# Test GitHub integration
npm run test:github
```

## Support

For issues or questions:
1. Check this documentation
2. Review GitHub API documentation
3. Check Prisma encryption best practices
4. Open an issue in the project repository

---

**Last Updated**: June 5, 2026  
**Version**: 1.0.0
