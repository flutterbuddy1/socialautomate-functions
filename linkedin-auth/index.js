import { Client, Databases, Query, ID } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    log('LinkedIn Auth Function triggered');

    // 1. Initialize Appwrite Client
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID;
    const COLLECTION_ID = 'connected_accounts';

    // 2. Validate Environment Variables
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (!process.env.APPWRITE_API_KEY) {
        error('Missing APPWRITE_API_KEY environment variable');
        return res.json({ success: false, error: 'Internal configuration error: API Key missing' }, 500);
    }

    if (!clientId || !clientSecret) {
        error('Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET environment variables');
        return res.json({ success: false, error: 'Internal configuration error: LinkedIn credentials missing' }, 500);
    }

    if (!DATABASE_ID) {
        error('Missing DATABASE_ID environment variable');
        return res.json({ success: false, error: 'Internal configuration error: Database ID missing' }, 500);
    }

    // 3. Extract input parameters
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        log('Received body: ' + JSON.stringify(body));
    } catch (e) {
        error('Failed to parse request body: ' + e.message);
        return res.json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const { code, userId, redirectUri } = body;

    if (!code || !userId) {
        error('Missing code or userId in request body');
        return res.json({ success: false, error: 'code and userId are required' }, 400);
    }

    const effectiveRedirectUri = redirectUri || process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:5173/linkedin/callback';

    try {
        log('Step 1: Exchanging code for access token...');

        // LinkedIn expects application/x-www-form-urlencoded
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('redirect_uri', effectiveRedirectUri);

        const tokenResponse = await axios.post(
            'https://www.linkedin.com/oauth/v2/accessToken',
            params.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const tokenData = tokenResponse.data;
        const accessToken = tokenData.access_token;
        const expiresIn = tokenData.expires_in;

        log('Access token received.');

        log('Step 2: Fetching LinkedIn user info...');
        const userResponse = await axios.get(
            'https://api.linkedin.com/v2/userinfo',
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const userData = userResponse.data;
        const linkedInUserId = userData.sub; // For OpenID Connect scopes

        if (!linkedInUserId) {
            error('Failed to retrieve LinkedIn User ID (sub).');
            return res.json({ success: false, error: 'Failed to retrieve LinkedIn account identity.' }, 400);
        }

        log(`Success! Found LinkedIn User: ${linkedInUserId}`);

        log('Step 3: Updating Appwrite Database...');
        const expiresAtDate = new Date();
        if (expiresIn) {
            expiresAtDate.setSeconds(expiresAtDate.getSeconds() + expiresIn);
        } else {
            // Default to 60 days if not provided
            expiresAtDate.setSeconds(expiresAtDate.getSeconds() + (60 * 24 * 60 * 60));
        }

        const accountData = {
            userId: userId,
            platform: 'linkedin',
            accessToken: accessToken,
            refreshToken: '', // LinkedIn authorization_code flow doesn't always provide refresh_token unless specifically requested/configured
            pageId: linkedInUserId, // Using pageId field for the account identity URN
            expiresAt: expiresAtDate.toISOString()
        };

        const existing = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
            Query.equal('userId', userId),
            Query.equal('platform', 'linkedin')
        ]);

        let result;
        if (existing.total > 0) {
            result = await databases.updateDocument(
                DATABASE_ID,
                COLLECTION_ID,
                existing.documents[0].$id,
                accountData
            );
            log('Existing connection updated.');
        } else {
            result = await databases.createDocument(
                DATABASE_ID,
                COLLECTION_ID,
                ID.unique(),
                accountData
            );
            log('New connection created.');
        }

        return res.json({
            success: true,
            message: 'LinkedIn connected successfully',
            data: {
                accountId: result.$id,
                linkedInUserId: linkedInUserId
            }
        });

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        error('Unexpected runtime error: ' + errorMsg);
        return res.json({ success: false, error: 'An internal server error occurred: ' + errorMsg }, 500);
    }
};
