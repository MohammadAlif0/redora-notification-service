/**
 * Backend Service for Sending Push Notifications
 * This service listens to Supabase notifications and sends them via Firebase Cloud Messaging
 * 
 * Setup:
 * 1. npm install express firebase-admin dotenv supabase-js
 * 2. Create .env file with Firebase credentials
 * 3. Run: node server.js
 */

const express = require('express');
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Firebase Admin SDK
// Load from environment variable or file
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Running on cloud - load from env variable
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  // Running locally - load from file
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORT = process.env.PORT || 3000;

/**
 * Send a notification via Firebase Cloud Messaging
 */
async function sendNotification(userId, title, body, type, data = {}) {
  try {
    console.log(`📱 Sending ${type} notification to user: ${userId}`);

    // Get user's FCM token from Supabase
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('fcm_token')
      .eq('id', userId)
      .single();

    if (error || !profiles?.fcm_token) {
      console.log(`⚠️ No FCM token found for user ${userId}`);
      return null;
    }

    const fcmToken = profiles.fcm_token;

    // Prepare the FCM message
    // IMPORTANT: We ONLY send data payload, NO notification field
    // This prevents Firebase from auto-displaying a default notification
    // Our app's background handler will display the custom notification instead
    const message = {
      data: {
        type: type,
        title: title,
        body: body,
        ...data,
      },
      token: fcmToken,
      android: {
        priority: 'high',
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
      },
    };

    // Send via Firebase Cloud Messaging
    const response = await admin.messaging().send(message);
    console.log(`✅ Notification sent successfully. Message ID: ${response}`);
    return response;
  } catch (error) {
    console.error(`❌ Error sending notification: ${error}`);
    throw error;
  }
}

/**
 * API endpoint to manually send a notification
 * POST /api/notifications/send
 */
app.post('/api/notifications/send', async (req, res) => {
  try {
    const { userId, title, body, type, data } = req.body;

    if (!userId || !title || !body || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const messageId = await sendNotification(userId, title, body, type, data);
    res.json({ success: true, messageId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Listen to Supabase notifications and send push notifications
 */
async function startListeningToNotifications() {
  console.log('🔔 Starting notification listener...');

  // Subscribe to new notifications in real-time
  const channel = supabase
    .channel('public:notifications')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications' },
      async (payload) => {
        try {
          const notification = payload.new;
          console.log('🔔 New notification detected:', notification);

          const { user_id, type, title, message, post_id, comment_id, sender_id } = notification;

          // Send the notification
          await sendNotification(
            user_id,
            title || getTitleForType(type),
            message || getMessageForType(type),
            type,
            {
              post_id: post_id || '',
              comment_id: comment_id || '',
              sender_id: sender_id || '',
            }
          );
        } catch (error) {
          console.error('❌ Error processing notification:', error);
        }
      }
    )
    .subscribe();

  console.log('✅ Notification listener started successfully');
}

/**
 * Get default title for notification type
 */
function getTitleForType(type) {
  const titles = {
    like: '❤️ New Like',
    comment: '💬 New Comment',
    follow: '👤 New Follower',
    reply: '↩️ New Reply',
    mention: '@️ Mention',
  };
  return titles[type] || 'New Notification';
}

/**
 * Get default message for notification type
 */
function getMessageForType(type) {
  const messages = {
    like: 'Someone liked your post',
    comment: 'Someone commented on your post',
    follow: 'Someone started following you',
    reply: 'Someone replied to your comment',
    mention: 'Someone mentioned you',
  };
  return messages[type] || 'You have a new notification';
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

/**
 * Start the server
 */
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);

  // Start listening to notifications after server starts
  startListeningToNotifications().catch(console.error);
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    admin.app().delete();
    process.exit(0);
  });
});

module.exports = app;
