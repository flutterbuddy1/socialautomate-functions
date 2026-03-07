import { Client, Databases, Query, ID } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    try {
        log('Facebook token exchange function started');

        // 1. Initialize Appwrite Client
        const client = new Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://appwrite.value97.com/v1')
            .setProject(process.env.APPWRITE_PROJECT_ID || '699bf381000b819680e2')
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new Databases(client);
        const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
        const COLLECTION_ID = 'connected_accounts';

        // 2. Validate Environment Variables
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;

        if (!process.env.APPWRITE_API_KEY) {
            error('Missing APPWRITE_API_KEY');
            return res.json({ success: false, error: 'Internal configuration error: APPWRITE_API_KEY is missing in function env.' }, 500);
        }

        if (!appId || !appSecret) {
            error('Missing META_APP_ID or META_APP_SECRET');
            return res.json({ success: false, error: 'Internal configuration error: Meta credentials missing in function env.' }, 500);
        }

        // 3. Extract and Validate Input
        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
            log('Request payload: ' + JSON.stringify(body));
        } catch (e) {
            error('JSON Parse Error: ' + e.message);
            return res.json({ success: false, error: 'Invalid JSON request body' }, 400);
        }

        const { code, userId, redirectUri } = body;

        if (!code || !userId) {
            error('Missing code or userId in request body');
            return res.json({ success: false, error: 'code and userId are required' }, 400);
        }

        const defaultRedirectUri = process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:5173/auth/facebook/callback';
        const finalRedirectUri = redirectUri || defaultRedirectUri;
        const encodedRedirectUri = encodeURIComponent(finalRedirectUri);

        log('Step 1: Exchanging code for short-lived User token...');
        const shortTokenResponse = await axios.get(
            `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodedRedirectUri}&client_secret=${appSecret}&code=${code}`
        );
        
        const shortToken = shortTokenResponse.data.access_token;
        if (!shortToken) throw new Error('Failed to retrieve short-lived token from Meta');
        log('Short-lived token received.');

        log('Step 2: Exchanging for long-lived User token...');
        const longTokenResponse = await axios.get(
            `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`
        );
        
        const longTokenData = longTokenResponse.data;
        const longUserToken = longTokenData.access_token;
        const expiresIn = longTokenData.expires_in || (60 * 24 * 60 * 60);
        log('Long-lived User token received.');

        log('Step 3: Fetching Facebook Pages...');
        const pagesResponse = await axios.get(
            `https://graph.facebook.com/v18.0/me/accounts?access_token=${longUserToken}`
        );
        const pagesData = pagesResponse.data;

        if (!pagesData.data || pagesData.data.length === 0) {
            error('No Facebook Pages found for this account.');
            return res.json({ success: false, error: 'No Facebook Pages found. Please ensure your Facebook account has at least one Page.' }, 400);
        }

        const page = pagesData.data[0];
        const pageAccessToken = page.access_token;
        const pageId = page.id;
        const pageName = page.name;

        log(`Target Page: ${pageName} (${pageId})`);

        log('Step 4: Updating Appwrite Database...');
        const expiresAtDate = new Date();
        expiresAtDate.setSeconds(expiresAtDate.getSeconds() + expiresIn);

        const accountData = {
            userId: userId,
            platform: 'facebook',
            accessToken: pageAccessToken,
            refreshToken: '', 
            pageId: pageId,
            expiresAt: expiresAtDate.toISOString()
        };

        const existing = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
            Query.equal('userId', userId),
            Query.equal('platform', 'facebook')
        ]);

        let result;
        if (existing.total > 0) {
            result = await databases.updateDocument(
                DATABASE_ID,
                COLLECTION_ID,
                existing.documents[0].$id,
                accountData
            );
            log('Existing connection updated successfully.');
        } else {
            result = await databases.createDocument(
                DATABASE_ID,
                COLLECTION_ID,
                ID.unique(),
                accountData
            );
            log('New connection created successfully.');
        }

        return res.json({
            success: true,
            message: 'Facebook connected successfully',
            data: {
                accountId: result.$id,
                pageId: pageId,
                pageName: pageName
            }
        });

    } catch (err) {
        const errorDetail = err.response ? JSON.stringify(err.response.data) : err.message;
        error('Runtime Exception: ' + errorDetail);
        
        // Ensure we always return a valid response to prevent Appwrite "failed" status
        return res.json({ 
            success: false, 
            error: 'Token exchange failed: ' + errorDetail,
            type: err.name
        }, 500);
    }
};
