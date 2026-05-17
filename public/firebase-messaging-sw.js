// Firebase Cloud Messaging Service Worker
// يستقبل الإشعارات في الخلفية حتى عندما يكون الموقع مغلقاً

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyD5iWweiKgE4JqcmlwouSuR1i569mpJqUU',
  authDomain: 'kotobi-notifications.firebaseapp.com',
  projectId: 'kotobi-notifications',
  storageBucket: 'kotobi-notifications.firebasestorage.app',
  messagingSenderId: '448918882174',
  appId: '1:448918882174:web:6e272f3b99a3fd345ed52f',
});

const messaging = firebase.messaging();

// ملاحظة: حمولة FCM تحتوي على webpush.notification الذي يعرضه المتصفح تلقائياً.
// لا نستدعي showNotification هنا لتجنب ظهور الإشعار مرتين.
// onBackgroundMessage يُستخدم فقط للتسجيل أو معالجة البيانات الإضافية.
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw] Background message (auto-displayed by webpush):', payload);
});

// النقر على الإشعار يفتح الموقع
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
