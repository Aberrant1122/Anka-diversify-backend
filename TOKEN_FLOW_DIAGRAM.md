# Per-Project GitHub Token - Flow Diagrams

## 1. Project Creation Flow

```
┌─────────────┐
│    User     │
└──────┬──────┘
       │ 1. Opens "Add Project" dialog
       │
       ▼
┌─────────────────────────────────┐
│  ProjectsHeader Component       │
│  ┌───────────────────────────┐  │
│  │ Name: My Project          │  │
│  │ GitHub URL: github.com... │  │
│  │ GitHub Token: ghp_xxx...  │  │
│  │ [Show/Hide] [Validating...│  │
│  └───────────────────────────┘  │
└──────────────┬──────────────────┘
               │ 2. User pastes token
               │
               ▼
┌─────────────────────────────────┐
│  Frontend Token Validation      │
│  - Check token length (≥20)     │
│  - Call API: validateGitHubToken│
└──────────────┬──────────────────┘
               │ 3. Validate with GitHub
               │
               ▼
┌─────────────────────────────────┐
│  GitHub API                     │
│  GET https://api.github.com/user│
│  Authorization: Bearer ghp_xxx  │
└──────────────┬──────────────────┘
               │ 4. Return user info
               │
               ▼
┌─────────────────────────────────┐
│  Frontend Shows Status          │
│  ✓ Valid token for 'username'  │
│  [Add Project] button enabled   │
└──────────────┬──────────────────┘
               │ 5. User clicks "Add Project"
               │
               ▼
┌─────────────────────────────────┐
│  POST /api/projects             │
│  {                              │
│    name, description,           │
│    githubUrl, githubToken       │
│  }                              │
└──────────────┬──────────────────┘
               │ 6. Create project
               │
               ▼
┌─────────────────────────────────┐
│  ProjectController              │
│  - Validate token again         │
│  - Encrypt token (AES-256)      │
│  - Save to database             │
└──────────────┬──────────────────┘
               │ 7. Return project (without token)
               │
               ▼
┌─────────────────────────────────┐
│  Database                       │
│  projects {                     │
│    id, name, githubUrl,         │
│    githubToken: "iv:encrypted"  │
│  }                              │
└─────────────────────────────────┘
```

## 2. Encryption Flow

```
┌──────────────────────┐
│  Plain Token         │
│  ghp_abc123...       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  encrypt(token)      │
│  ┌────────────────┐  │
│  │ Generate IV    │  │
│  │ (random 16B)   │  │
│  └────────┬───────┘  │
│           │          │
│  ┌────────▼───────┐  │
│  │ AES-256-CBC    │  │
│  │ Key: ENV var   │  │
│  │ IV: random     │  │
│  └────────┬───────┘  │
│           │          │
│  ┌────────▼───────┐  │
│  │ Format:        │  │
│  │ iv:encrypted   │  │
│  └────────────────┘  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Encrypted Token     │
│  a1b2c3...:d4e5f6... │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Database Storage    │
│  (unreadable)        │
└──────────────────────┘
```

## 3. Decryption Flow (When AI Pushes Code)

```
┌──────────────────────┐
│  AI Agent            │
│  "Push changes"      │
└──────────┬───────────┘
           │ 1. Get project
           │
           ▼
┌──────────────────────┐
│  Database            │
│  githubToken:        │
│  "a1b2...:d4e5..."   │
└──────────┬───────────┘
           │ 2. Fetch encrypted token
           │
           ▼
┌──────────────────────┐
│  decrypt(token)      │
│  ┌────────────────┐  │
│  │ Split IV:data  │  │
│  └────────┬───────┘  │
│           │          │
│  ┌────────▼───────┐  │
│  │ AES-256-CBC    │  │
│  │ Key: ENV var   │  │
│  │ IV: from token │  │
│  └────────┬───────┘  │
│           │          │
│  ┌────────▼───────┐  │
│  │ Plain token    │  │
│  │ ghp_abc123...  │  │
│  └────────────────┘  │
└──────────┬───────────┘
           │ 3. Decrypted token (in memory only)
           │
           ▼
┌──────────────────────┐
│  GitHub API Call     │
│  Authorization:      │
│  Bearer ghp_abc123   │
└──────────┬───────────┘
           │ 4. Push commit
           │
           ▼
┌──────────────────────┐
│  GitHub Repository   │
│  Commit created ✓    │
└──────────────────────┘
           │
           │ 5. Token cleared from memory
           ▼
       [Done]
```

## 4. Multi-User Workflow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   User A    │    │   User B    │    │   User C    │
│  (Admin)    │    │ (Developer) │    │ (Developer) │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       │ Token: ghp_aaa   │ Token: ghp_bbb   │ Token: ghp_ccc
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────────────────────────────────────────┐
│               Anka OS Platform                   │
└──────┬───────────────────┬───────────────────┬───┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Project 1  │    │  Project 2  │    │  Project 3  │
│  Token: aaa │    │  Token: bbb │    │  Token: ccc │
│  (encrypted)│    │  (encrypted)│    │  (encrypted)│
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Repo A     │    │  Repo B     │    │  Repo C     │
│  (Private)  │    │  (Public)   │    │  (Private)  │
└─────────────┘    └─────────────┘    └─────────────┘

Benefits:
✓ Each user's token used for their projects
✓ Commits attributed to correct GitHub user
✓ Fine-grained access control per project
✓ Token compromise affects only one project
✓ Easy to revoke individual project access
```

## 5. Security Layers

```
┌─────────────────────────────────────────────┐
│  Layer 1: HTTPS/TLS                         │
│  ✓ Token encrypted in transit               │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Layer 2: Backend Validation                │
│  ✓ Token validated with GitHub API          │
│  ✓ Only valid tokens accepted               │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Layer 3: Encryption at Rest                │
│  ✓ AES-256-CBC encryption                   │
│  ✓ Random IV per token                      │
│  ✓ Encryption key in environment            │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Layer 4: Database Storage                  │
│  ✓ Tokens unreadable without key            │
│  ✓ No plain text tokens stored              │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Layer 5: API Response Filtering            │
│  ✓ Tokens never returned in responses       │
│  ✓ Only validation status returned          │
└─────────────────────────────────────────────┘
```

## 6. Token Lifecycle

```
┌─────────────┐
│   CREATE    │  User generates token on GitHub
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  VALIDATE   │  System validates with GitHub API
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   ENCRYPT   │  AES-256-CBC encryption
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   STORE     │  Save to database (encrypted)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    USE      │  Decrypt → Use → Clear from memory
└──────┬──────┘  (repeated for each GitHub operation)
       │
       ▼
┌─────────────┐
│   UPDATE    │  User updates token (optional)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   REVOKE    │  User revokes on GitHub (or expires)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   DELETE    │  Remove from project (optional)
└─────────────┘
```

## 7. Error Handling Flow

```
User Action: Create Project
     │
     ▼
Token Validation
     │
     ├─ Token too short? ──→ Show error: "Token must be at least 20 characters"
     │
     ├─ Invalid format? ───→ Show error: "Invalid token format"
     │
     ├─ GitHub API fail? ──→ Show error: "Failed to validate token"
     │
     ├─ Token invalid? ────→ Show error: "Invalid or expired token"
     │
     ├─ No repo scope? ────→ Show error: "Token needs 'repo' scope"
     │
     └─ Valid? ────────────→ Continue
             │
             ▼
     Encryption
             │
             ├─ Key missing? ──→ Show error: "System configuration error"
             │
             ├─ Encrypt fail? ─→ Show error: "Failed to encrypt token"
             │
             └─ Success? ──────→ Continue
                     │
                     ▼
             Database Save
                     │
                     ├─ DB error? ──→ Show error: "Failed to save project"
                     │
                     └─ Success? ──→ Show success: "Project created"
```

## 8. Comparison: Before vs After

### Before (Global Token)
```
┌─────────────┐
│    .env     │
│             │
│ GITHUB_     │
│ TOKEN=xxx   │  ← Single token for all operations
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│  All GitHub Operations  │
│  - User A's commits     │
│  - User B's commits     │  ← All attributed to token owner
│  - User C's commits     │
└─────────────────────────┘

Issues:
✗ All commits by one GitHub user
✗ Token in environment file
✗ Same token for all projects
✗ Security risk if exposed
✗ No per-user attribution
```

### After (Per-Project Token)
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Project 1  │  │  Project 2  │  │  Project 3  │
│  Token: A   │  │  Token: B   │  │  Token: C   │
│  (encrypted)│  │  (encrypted)│  │  (encrypted)│
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       ▼                ▼                ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Commits by │  │  Commits by │  │  Commits by │
│   User A    │  │   User B    │  │   User C    │
└─────────────┘  └─────────────┘  └─────────────┘

Benefits:
✓ Proper commit attribution
✓ Tokens encrypted in DB
✓ Different tokens per project
✓ Isolated security risk
✓ Per-user control
```

---

**Visual Guide Version**: 1.0.0  
**Last Updated**: June 5, 2026
