import { Client, Databases, Query } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    log('LinkedIn Post Function triggered');

    // 1. Initialize Appwrite Client
    const client = new Client();

    const endpoint = process.env.APPWRITE_ENDPOINT;
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;

    if (!apiKey || !endpoint || !projectId) {
        error('Missing core Appwrite environment variables');
        return res.json({ success: false, error: 'Internal configuration error: Appwrite variables missing' });
    }

    client
        .setEndpoint(endpoint)
        .setProject(projectId)
        .setKey(apiKey);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const ACCOUNTS_COLLECTION = 'connected_accounts';

    // 2. Extract input parameters
    let body;
    try {
        if (!req.body) {
            throw new Error('Request body is empty');
        }
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        log('Received body: ' + JSON.stringify(body));
    } catch (e) {
        error('Failed to parse request body: ' + e.message);
        return res.json({ success: false, error: 'Invalid JSON body: ' + e.message });
    }

    const { userId, content, accountId } = body;

    if (!userId || !content) {
        error('Missing userId or content in request body');
        return res.json({ success: false, error: 'userId and content are required' });
    }

    try {
        // 3. Fetch LinkedIn credentials
        let account;
        if (accountId) {
            account = await databases.getDocument(DATABASE_ID, ACCOUNTS_COLLECTION, accountId);
        } else {
            const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
                Query.equal('userId', userId),
                Query.equal('platform', 'linkedin')
            ]);
            if (accounts.total === 0) {
                error(`No connected LinkedIn account found for user ${userId}`);
                return res.json({ success: false, error: 'No connected LinkedIn account found' });
            }
            account = accounts.documents[0];
        }

        const accessToken = account.accessToken;
        const linkedInUserId = account.pageId;

        if (!accessToken || !linkedInUserId) {
            error('LinkedIn credentials or User ID missing in account record.');
            return res.json({ success: false, error: 'LinkedIn credentials missing' });
        }

        log(`Attempting to post for LinkedIn User: ${linkedInUserId}`);

        // 4. Publish to LinkedIn using ugcPosts API
        const postData = {
            author: `urn:li:person:${linkedInUserId}`,
            lifecycleState: "PUBLISHED",
            specificContent: {
                "com.linkedin.ugc.ShareContent": {
                    shareCommentary: {
                        text: content
                    },
                    shareMediaCategory: "NONE"
                }
            },
            visibility: {
                "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
            }
        };

        const postResponse = await axios.post(
            'https://api.linkedin.com/v2/ugcPosts',
            postData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Restli-Protocol-Version': '2.0.0'
                }
            }
        );

        log('Post successful: ' + JSON.stringify(postResponse.data));

        return res.json({
            success: true,
            message: 'Post published successfully to LinkedIn',
            postId: postResponse.data.id
        });

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        error('Unexpected runtime error: ' + errorMsg);
        return res.json({ success: false, error: 'Failed to publish to LinkedIn: ' + errorMsg });
    }
};
