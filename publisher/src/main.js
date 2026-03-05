import { Client, Databases, Storage, Query, Functions } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const functions = new Functions(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const ACCOUNTS_COLLECTION = 'connected_accounts';
    const POSTS_COLLECTION = 'scheduled_posts';
    const BUCKET_ID = '699ea200000d168a2f64';
    const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;

    try {
        const payload = JSON.parse(req.body || '{}');
        const { userId, platform, content, imageField, $id: postId } = payload;

        if (!postId) throw new Error('Post ID ($id) is missing in payload.');

        log(`[Publisher] Processing post ${postId} for ${platform}...`);

        // 1. Fetch connected account (Prefer account_id if available)
        let account;
        if (payload.account_id) {
            account = await databases.getDocument(DATABASE_ID, ACCOUNTS_COLLECTION, payload.account_id);
        } else {
            const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
                Query.equal('userId', userId),
                Query.equal('platform', platform)
            ]);
            if (accounts.total === 0) throw new Error(`No connected account found for ${platform}`);
            account = accounts.documents[0];
        }
        const accessToken = account.accessToken;
        const instagramBusinessId = account.pageId;

        // 2. Prepare Media URL
        // Bucket MUST have read("any") permission
        const mediaUrl = `${process.env.APPWRITE_ENDPOINT}/storage/buckets/${BUCKET_ID}/files/${imageField}/view?project=${PROJECT_ID}`;

        if (platform === 'instagram') {
            if (!instagramBusinessId) throw new Error('Instagram Business ID (pageId) is missing.');
            if (!imageField) throw new Error('Instagram requires an image.');

            // Container
            const containerRes = await axios.post(
                `https://graph.facebook.com/v19.0/${instagramBusinessId}/media`,
                {
                    image_url: mediaUrl,
                    caption: content,
                    access_token: accessToken
                }
            );

            const creation_id = containerRes.data.id;

            // Publish
            await axios.post(
                `https://graph.facebook.com/v19.0/${instagramBusinessId}/media_publish`,
                {
                    creation_id: creation_id,
                    access_token: accessToken
                }
            );
        } else if (platform === 'linkedin') {
            log(`[Publisher] Calling linkedin-post function for post ${postId}...`);

            const LINKEDIN_POST_FUNCTION_ID = process.env.LINKEDIN_POST_FUNCTION_ID || '69a14f9a0035853190b6';

            const payload = JSON.stringify({
                userId: userId,
                content: content,
                accountId: payload.account_id
            });

            const execution = await functions.createExecution(
                LINKEDIN_POST_FUNCTION_ID,
                payload
            );

            if (execution.status !== 'completed') {
                throw new Error(`LinkedIn function failed with status: ${execution.status}`);
            }

            const result = JSON.parse(execution.responseBody);
            if (!result.success) {
                throw new Error(result.error || 'LinkedIn post function returned failure');
            }
        } else {
            // Placeholder for other platforms
            log(`Platform ${platform} publishing logic not implemented yet.`);
            throw new Error(`Auto-publishing for ${platform} is not currently active.`);
        }

        // 3. Success
        await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, postId, {
            status: 'published',
            publishedAt: new Date().toISOString()
        });

        log(`Successfully published post ${postId}`);
        return res.json({ success: true });

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        error('Individual Publisher Error: ' + errorMsg);

        try {
            const payload = JSON.parse(req.body || '{}');
            if (payload.$id) {
                await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, payload.$id, {
                    status: 'failed',
                    errorLog: errorMsg.slice(0, 1000)
                });
            }
        } catch (ignore) { }

        return res.json({ success: false, error: errorMsg }, 500);
    }
};
