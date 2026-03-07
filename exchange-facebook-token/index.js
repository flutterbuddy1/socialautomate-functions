import { Client, Databases, Query, ID } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    log('Facebook token exchange function triggered');

    // 1. Initialize Appwrite Client
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID;
    const COLLECTION_ID = 'connected_accounts';

    // 2. Validate Environment Variables
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!process.env.APPWRITE_API_KEY) {
        error('Missing APPWRITE_API_KEY environment variable');
        return res.json({ success: false, error: 'Internal configuration error: API Key missing' }, 500);
    }

    if (!appId || !appSecret) {
        error('Missing META_APP_ID or META_APP_SECRET environment variables');
        return res.json({ success: false, error: 'Internal configuration error: Meta credentials missing' }, 500);
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

    const defaultRedirectUri = process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:5173/auth/facebook/callback';
    const finalRedirectUri = redirectUri || defaultRedirectUri;

    try {
        log('Step 1: Exchanging code for short-lived User token...');
        const shortTokenResponse = await axios.get(
            `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${appId}&redirect_uri=${finalRedirectUri}&client_secret=${appSecret}&code=${code}`
        );
        const shortTokenData = shortTokenResponse.data;
        const shortToken = shortTokenData.access_token;
        log('Short-lived token received.');

        log('Step 2: Exchanging for long-lived User token...');
        const longTokenResponse = await axios.get(
            `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`
        );
        const longTokenData = longTokenResponse.data;
        const longUserToken = longTokenData.access_token;
        const expiresIn = longTokenData.expires_in || (60 * 24 * 60 * 60);
        log('Long-lived User token received.');

        log('Step 3: Fetching Facebook Pages and Page Access Tokens...');
        const pagesResponse = await axios.get(
            `https://graph.facebook.com/v18.0/me/accounts?access_token=${longUserToken}`
        );
        const pagesData = pagesResponse.data;

        if (!pagesData.data || pagesData.data.length === 0) {
            error('No Facebook Pages found.');
            return res.json({ success: false, error: 'No Facebook Pages found associated with this account. Please ensure you have a Facebook Page.' }, 400);
        }

        // For now, we take the first page. 
        // Improvement: Allow user to select a page in the frontend.
        const page = pagesData.data[0];
        const pageAccessToken = page.access_token;
        const pageId = page.id;
        const pageName = page.name;

        log(`Successfully found Page: ${pageName} (${pageId})`);

        log('Step 4: Updating Appwrite Database...');
        const expiresAtDate = new Date();
        expiresAtDate.setSeconds(expiresAtDate.getSeconds() + expiresIn);

        const accountData = {
            userId: userId,
            platform: 'facebook',
            accessToken: pageAccessToken,
            refreshToken: '', // Facebook Page tokens don't have refresh tokens in the same way, long-lived ones last 60 days or are indefinite
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
            message: 'Facebook connected successfully',
            data: {
                accountId: result.$id,
                pageId: pageId,
                pageName: pageName
            }
        });

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        error('Facebook Exchange Error: ' + errorMsg);
        return res.json({ success: false, error: 'An internal server error occurred: ' + errorMsg }, 500);
    }
};
