// auth.js — Firebase Authentication middleware and helper for Chip backend.
//
// Extracts Firebase UID from the `Authorization: Bearer <token>` header or `x-user-id` fallback header.
// If firebase-admin is configured via credentials, it verifies the token signature.

let admin = null;

try {
  // Dynamically load firebase-admin if installed
  const firebaseAdminModule = await import('firebase-admin');
  admin = firebaseAdminModule.default || firebaseAdminModule;

  if (!admin.apps || !admin.apps.length) {
    if (process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp();
      console.log('[auth] Firebase Admin SDK initialized.');
    }
  }
} catch {
  // firebase-admin is optional; fallback to extracting unverified headers/params when SDK is not present
}

/**
 * Express middleware to extract userId from headers or token.
 * Attaches `req.userId` if present.
 */
export async function extractUser(req, res, next) {
  const authHeader = req.headers.authorization;
  const directUserId = req.headers['x-user-id'] || req.query.userId || req.body?.userId;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    if (admin && admin.apps && admin.apps.length) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.userId = decodedToken.uid;
        return next();
      } catch (err) {
        console.warn(`[auth] Invalid Firebase token: ${err.message}`);
      }
    } else {
      // Without admin SDK, use token string or direct ID if provided
      req.userId = token;
      return next();
    }
  }

  if (directUserId) {
    req.userId = String(directUserId);
  }

  next();
}
