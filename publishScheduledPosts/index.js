import { Client, Databases, Query } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const ACCOUNTS_COLLECTION = 'connected_accounts';
    const POSTS_COLLECTION = 'scheduled_posts';
    const BUCKET_ID = '699ea200000d168a2f64';

    async function publishInstagramPost(post) {
        log(`[Instagram] Attempting post ${post.$id}...`);

        // 1. Fetch connected account (Prefer account_id if available)
        let account;
        if (post.account_id) {
            account = await databases.getDocument(DATABASE_ID, ACCOUNTS_COLLECTION, post.account_id);
        } else {
            const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
                Query.equal('userId', post.userId),
                Query.equal('platform', 'instagram')
            ]);
            if (accounts.total === 0) throw new Error(`No connected Instagram account found for user ${post.userId}`);
            account = accounts.documents[0];
        }
        const accessToken = account.accessToken;
        const instagramBusinessId = account.pageId;

        if (!instagramBusinessId) {
            throw new Error('instagramBusinessId (pageId) is missing for the connected account.');
        }

        // 2. Image URL
        // IMPORTANT: Storage Bucket 699ea200000d168a2f64 MUST have "Read" permission for "All Users" (role:all)
        const imageUrl = `${ENDPOINT}/storage/buckets/${BUCKET_ID}/files/${post.imageField}/view?project=${PROJECT_ID}`;
        log(`[Instagram] Image URL: ${imageUrl}`);

        // 3. Create media container
        const containerRes = await axios.post(
            `https://graph.facebook.com/v19.0/${instagramBusinessId}/media`,
            {
                image_url: imageUrl,
                caption: post.content,
                access_token: accessToken
            }
        );

        const creation_id = containerRes.data.id;
        log(`[Instagram] Media container created: ${creation_id}`);

        // 4. Publish media
        await axios.post(
            `https://graph.facebook.com/v19.0/${instagramBusinessId}/media_publish`,
            {
                creation_id: creation_id,
                access_token: accessToken
            }
        );

        log(`[Instagram] Post ${post.$id} published successfully.`);

        // 5. Update status
        await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
            status: 'published',
            publishedAt: new Date().toISOString()
        });
    }

    async function publishLinkedInPost(post) {
        log(`[LinkedIn] Attempting post ${post.$id}...`);

        // 1. Fetch connected account (Prefer account_id if available)
        let account;
        if (post.account_id) {
            account = await databases.getDocument(DATABASE_ID, ACCOUNTS_COLLECTION, post.account_id);
        } else {
            const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
                Query.equal('userId', post.userId),
                Query.equal('platform', 'linkedin')
            ]);
            if (accounts.total === 0) throw new Error(`No connected LinkedIn account found for user ${post.userId}`);
            account = accounts.documents[0];
        }
        const accessToken = account.accessToken;
        const linkedInUserId = account.pageId;

        if (!linkedInUserId) {
            throw new Error('linkedInUserId (pageId) is missing for the connected account.');
        }

        // 2. Publish to LinkedIn using ugcPosts API
        const postData = {
            author: `urn:li:person:${linkedInUserId}`,
            lifecycleState: "PUBLISHED",
            specificContent: {
                "com.linkedin.ugc.ShareContent": {
                    shareCommentary: {
                        text: post.content
                    },
                    shareMediaCategory: "NONE"
                }
            },
            visibility: {
                "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
            }
        };

        await axios.post(
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

        log(`[LinkedIn] Post ${post.$id} published successfully.`);

        // 3. Update status
        await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
            status: 'published',
            publishedAt: new Date().toISOString()
        });
    }

    try {
        log('Cron job started...');
        const now = new Date().toISOString();

        const pendingPosts = await databases.listDocuments(DATABASE_ID, POSTS_COLLECTION, [
            Query.equal('status', 'pending'),
            Query.lessThanEqual('scheduledAt', now),
            Query.or([
                Query.equal('platform', 'instagram'),
                Query.equal('platform', 'linkedin')
            ])
        ]);

        log(`Processing ${pendingPosts.total} pending posts...`);

        for (const post of pendingPosts.documents) {
            try {
                if (post.platform === 'instagram') {
                    await publishInstagramPost(post);
                } else if (post.platform === 'linkedin') {
                    await publishLinkedInPost(post);
                }
            } catch (postErr) {
                const errorMsg = postErr.response ? JSON.stringify(postErr.response.data) : postErr.message;
                error(`[Error] Post ${post.$id}: ${errorMsg}`);

                await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
                    status: 'failed',
                    errorLog: errorMsg.slice(0, 1000)
                });
            }
        }

        return res.json({ success: true, count: pendingPosts.total });

    } catch (err) {
        error('Execution Error: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
