import { Client, Databases, Query, ID } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    log('LinkedIn Auth Function triggered');

    // 1. Initialize Appwrite Client
    const client = new Client();

    // Safely get env variables
    const endpoint = process.env.APPWRITE_ENDPOINT;
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;

    if (!apiKey || !endpoint || !projectId) {
        const msg = 'Missing core Appwrite environment variables (API_KEY, ENDPOINT, or PROJECT_ID)';
        error(msg);
        return res.json({ success: false, error: msg }, 500);
    }

    client
        .setEndpoint(endpoint)
        .setProject(projectId)
        .setKey(apiKey);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const COLLECTION_ID = 'connected_accounts';

    // 2. Validate LinkedIn Environment Variables
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        const msg = 'Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET environment variables';
        error(msg);
        return res.json({ success: false, error: msg }, 500);
    }

    // 3. Extract input parameters
    let body;
    try {
        if (!req.body) {
            throw new Error('Request body is empty');
        }
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        log('Received body: ' + JSON.stringify(body));
    } catch (e) {
        const msg = 'Failed to parse request body: ' + e.message;
        error(msg);
        return res.json({ success: false, error: msg }, 400);
    }

    const { code, userId, redirectUri } = body;

    if (!code || !userId) {
        const msg = 'code and userId are required in the request body';
        error(msg);
        return res.json({ success: false, error: msg }, 400);
    }

    const effectiveRedirectUri = redirectUri || process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:5173/linkedin/callback';
    log('Effective Redirect URI: ' + effectiveRedirectUri);

    try {
        log('Step 1: Exchanging code for access token...');

        const tokenParams = new URLSearchParams();
        tokenParams.append('grant_type', 'authorization_code');
        tokenParams.append('code', code);
        tokenParams.append('client_id', clientId);
        tokenParams.append('client_secret', clientSecret);
        tokenParams.append('redirect_uri', effectiveRedirectUri);

        const tokenResponse = await axios.post(
            'https://www.linkedin.com/oauth/v2/accessToken',
            tokenParams.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const tokenData = tokenResponse.data;
        const accessToken = tokenData.access_token;
        const expiresIn = tokenData.expires_in;

        if (!accessToken) {
            throw new Error('AccessToken not found in LinkedIn response');
        }

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
            throw new Error('Failed to retrieve LinkedIn User ID (sub field missing in userinfo response)');
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
            refreshToken: tokenData.refresh_token || '',
            pageId: linkedInUserId,
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
        }, 200);

    } catch (err) {
        // Robust error extraction
        let errorMsg = err.message;
        let statusCode = 500;

        if (err.response) {
            // Axios error with response from server
            statusCode = err.response.status || 500;
            const data = err.response.data;
            errorMsg = (data && typeof data === 'object')
                ? JSON.stringify(data)
                : (data || err.message);
        } else if (err.request) {
            // Axios error where request was made but no response received
            errorMsg = 'No response received from LinkedIn API';
        }

        error('Unexpected runtime error: ' + errorMsg);
        return res.json({
            success: false,
            error: 'LinkedIn Auth Error: ' + errorMsg
        }, statusCode);
    }
};
