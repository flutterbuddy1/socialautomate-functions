import { Client, Databases, Query } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    log('LinkedIn Post Function triggered');

    // 1. Initialize Appwrite Client
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID;
    const ACCOUNTS_COLLECTION = 'connected_accounts';

    // 2. Extract input parameters
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        log('Received body: ' + JSON.stringify(body));
    } catch (e) {
        error('Failed to parse request body: ' + e.message);
        return res.json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const { userId, content, accountId } = body;

    if (!userId || !content) {
        error('Missing userId or content in request body');
        return res.json({ success: false, error: 'userId and content are required' }, 400);
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
                return res.json({ success: false, error: 'No connected LinkedIn account found' }, 404);
            }
            account = accounts.documents[0];
        }

        const accessToken = account.accessToken;
        const linkedInUserId = account.pageId;

        if (!accessToken || !linkedInUserId) {
            error('LinkedIn credentials or User ID missing in account record.');
            return res.json({ success: false, error: 'LinkedIn credentials missing' }, 400);
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
        return res.json({ success: false, error: 'Failed to publish to LinkedIn: ' + errorMsg }, 500);
    }
};
