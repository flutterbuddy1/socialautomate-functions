import { Client, Databases, Storage, Query } from 'node-appwrite';
import axios from 'axios';

/**
 * Function 7: Publish Post
 * - Publish to Meta Graph API or X API
 * - Handle errors
 * - Update database status
 */

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const storage = new Storage(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const ACCOUNTS_COLLECTION = 'connected_accounts';
    const POSTS_COLLECTION = 'scheduled_posts';
    const BUCKET_ID = 'generated_images';

    try {
        const post = JSON.parse(req.body);
        const { userId, platform, content, mediaFileId, $id: postId } = post;

        // 1. Fetch OAuth Credentials for the platform
        const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
            Query.equal('userId', userId),
            Query.equal('platform', platform)
        ]);

        if (accounts.total === 0) {
            throw new Error(`No connected account found for ${platform}`);
        }

        const { accessToken, platformUserId } = accounts.documents[0];

        // 2. Fetch Media if exists
        let mediaUrl = null;
        if (mediaFileId) {
            // In production, you'd generate a temporary public URL or use Storage SDK
            mediaUrl = `${process.env.APPWRITE_ENDPOINT}/storage/buckets/${BUCKET_ID}/files/${mediaFileId}/view?project=${process.env.APPWRITE_PROJECT_ID}`;
        }

        log(`Publishing to ${platform}...`);

        let publishResult;
        if (platform === 'facebook' || platform === 'instagram') {
            // Meta Graph API Implementation
            const endpoint = `https://graph.facebook.com/v19.0/${platformUserId}/feed`;
            publishResult = await axios.post(endpoint, {
                message: content,
                link: mediaUrl,
                access_token: accessToken
            });
        } else if (platform === 'x') {
            // X API v2 Implementation
            publishResult = await axios.post('https://api.twitter.com/2/tweets', {
                text: content
            }, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
        }

        // 3. Update Post Status
        await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, postId, {
            status: 'published',
            publishedAt: new Date().toISOString(),
            platformResponse: JSON.stringify(publishResult.data)
        });

        log(`Successfully published post ${postId}`);
        return res.json({ success: true });

    } catch (err) {
        error('Publisher Error: ' + err.message);

        // Update status to failed
        if (req.body) {
            const post = JSON.parse(req.body);
            await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
                status: 'failed',
                errorLog: err.message
            });
        }

        return res.json({ success: false, error: err.message }, 500);
    }
};
