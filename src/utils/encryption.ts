import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey || envKey.length < 32) {
    console.warn('WARNING: ENCRYPTION_KEY not set or too short. Using fallback (NOT SECURE FOR PRODUCTION)');
  }
  _key = envKey
    ? Buffer.from(envKey.padEnd(32, '0').slice(0, 32))
    : Buffer.alloc(32, 'insecure-fallback-key-change-me');
  return _key;
}

/**
 * Encrypt sensitive data (like GitHub tokens)
 * Returns base64 encoded string in format: iv:encryptedData
 */
export function encrypt(text: string): string {
  if (!text) return '';
  
  try {
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Store IV with encrypted data (needed for decryption)
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt sensitive data
 * Expects format: iv:encryptedData
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return '';
  
  try {
    const key = getKey();
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedData = parts[1];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
}

/**
 * Validate a GitHub token by making a test API call
 */
export async function validateGitHubToken(token: string): Promise<{ valid: boolean; username?: string; scopes?: string[]; error?: string }> {
  try {
    // Clean the token (remove any whitespace)
    const cleanToken = token.trim();
    
    if (!cleanToken) {
      return { valid: false, error: 'Token is empty' };
    }

    if (typeof fetch === 'undefined') {
      return { valid: false, error: 'fetch API not available in this Node.js version (need v18+)' };
    }

    // Try multiple authentication methods
    const authMethods = [
      { name: 'Bearer', value: `Bearer ${cleanToken}` },
      { name: 'token', value: `token ${cleanToken}` },
    ];

    for (const method of authMethods) {
      try {
        console.log(`Validating GitHub token with ${method.name} auth...`);
        const response = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': method.value,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Anka-OS',
          },
        });

        if (response.ok) {
          const data: any = await response.json();
          const scopes = response.headers.get('x-oauth-scopes')?.split(',').map(s => s.trim()).filter(Boolean) || [];
          console.log(`GitHub token valid for user: ${data.login}`);
          return {
            valid: true,
            username: data.login,
            scopes,
          };
        } else if (response.status === 401) {
          console.log(`GitHub API returned 401 with ${method.name} auth, trying next method...`);
          continue;
        } else {
          const errorText = await response.text().catch(() => '');
          console.error(`GitHub API error: ${response.status} with ${method.name} auth`, errorText);
          return {
            valid: false,
            error: `GitHub API returned status ${response.status}`,
          };
        }
      } catch (fetchError: any) {
        console.error(`GitHub API fetch error (${method.name}):`, fetchError?.message || fetchError);
        continue;
      }
    }

    // If we get here, all auth methods failed
    return {
      valid: false,
      error: 'Invalid token or token expired',
    };
  } catch (error: any) {
    console.error('GitHub token validation error:', error?.message || error);
    return {
      valid: false,
      error: `Failed to validate token with GitHub API: ${error?.message || 'Unknown error'}`,
    };
  }
}
