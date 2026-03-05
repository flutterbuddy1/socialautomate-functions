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

    const { userId, content, accountId, imageField } = body;

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
        let linkedInUserId = account.pageId;

        if (!accessToken || !linkedInUserId) {
            error('LinkedIn credentials or User ID missing in account record.');
            return res.json({ success: false, error: 'LinkedIn credentials missing' });
        }

        // Ensure linkedInUserId is correctly prefixed as a URN if not already
        const authorUrn = linkedInUserId.startsWith('urn:li:')
            ? linkedInUserId
            : `urn:li:person:${linkedInUserId}`;

        log(`Attempting to post for LinkedIn User URN: ${authorUrn}`);

        let imageUrn = null;

        // --- IMAGE UPLOAD LOGIC ---
        if (imageField) {
            log(`[LinkedIn] Processing image: ${imageField}`);
            try {
                // 1. Register Upload
                const registerRes = await axios.post(
                    'https://api.linkedin.com/v2/assets?action=registerUpload',
                    {
                        registerUploadRequest: {
                            recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
                            owner: authorUrn,
                            serviceRelationships: [
                                {
                                    relationshipType: "OWNER",
                                    identifier: "urn:li:userGeneratedContent"
                                }
                            ]
                        }
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );

                const uploadUrl = registerRes.data.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
                imageUrn = registerRes.data.value.asset;
                log(`[LinkedIn] Image asset registered: ${imageUrn}`);

                // 2. Download from Appwrite
                const BUCKET_ID = '699ea200000d168a2f64'; // GENERATED_IMAGES bucket
                const imageUrl = `${endpoint}/storage/buckets/${BUCKET_ID}/files/${imageField}/view?project=${projectId}`;
                log(`[LinkedIn] Downloading image from: ${imageUrl}`);

                const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                const imageBuffer = imageRes.data;

                // 3. Upload to LinkedIn
                await axios.put(uploadUrl, imageBuffer, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'image/jpeg' // Or detect type if possible, jpeg/png are safe
                    }
                });
                log(`[LinkedIn] Image binary uploaded to LinkedIn.`);

            } catch (imgErr) {
                const imgErrMsg = imgErr.response ? JSON.stringify(imgErr.response.data) : imgErr.message;
                error(`[LinkedIn] Image upload failed: ${imgErrMsg}`);
                throw new Error(`LinkedIn image upload failed: ${imgErrMsg}`);
            }
        }

        // 4. Publish to LinkedIn using ugcPosts API
        const postData = {
            author: authorUrn,
            lifecycleState: "PUBLISHED",
            specificContent: {
                "com.linkedin.ugc.ShareContent": {
                    shareCommentary: {
                        text: content
                    },
                    shareMediaCategory: imageUrn ? "IMAGE" : "NONE",
                    media: imageUrn ? [
                        {
                            status: "READY",
                            description: {
                                text: content.slice(0, 100) // alt text
                            },
                            media: imageUrn,
                            title: {
                                text: "Scheduled Post"
                            }
                        }
                    ] : []
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
