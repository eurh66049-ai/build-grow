import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import { KOTOBI_AI_USER_ID, resolveKotobiAiAvatar } from '@/utils/kotobiAi';

type ConversationsCacheEntry = {
  conversations: Conversation[];
  totalUnread: number;
  fetchedAt: number;
};

type MessagePreviewRow = {
  id?: string;
  conversation_id: string;
  content: string | null;
  sender_id: string;
  created_at: string;
  message_type?: string | null;
  transcript?: string | null;
  audio_url?: string | null;
};

// كاش داخل الذاكرة لمنع إعادة الجلب عند الرجوع بسرعة
const CONVERSATIONS_STALE_MS = 15_000;
const conversationsCache = new Map<string, ConversationsCacheEntry>();

export interface Conversation {
  id: string;
  participant_1: string;
  participant_2: string;
  created_at: string;
  last_message_at: string;
  other_user?: {
    id: string;
    username: string;
    avatar_url: string | null;
    last_seen?: string | null;
  };
  last_message?: {
    content: string;
    sender_id: string;
    created_at: string;
  };
  unread_count: number;
}

const getLastMessagePreview = (message?: MessagePreviewRow | null) => {
  if (!message) return undefined;

  return {
    sender_id: message.sender_id,
    created_at: message.created_at,
    content:
      (message.content && message.content.trim()) ||
      (message.transcript && message.transcript.trim()) ||
      (message.message_type === 'audio' || message.message_type === 'voice' || message.audio_url
        ? '🎤 رسالة صوتية'
        : ''),
  };
};

const sortByLatestActivity = (items: Conversation[]) =>
  [...items].sort((a, b) => {
    const aTime = new Date(a.last_message?.created_at || a.last_message_at || a.created_at).getTime();
    const bTime = new Date(b.last_message?.created_at || b.last_message_at || b.created_at).getTime();
    return bTime - aTime;
  });

export const publishConversationPreviewUpdate = (currentUserId: string, message: MessagePreviewRow) => {
  const cached = conversationsCache.get(currentUserId);
  if (cached) {
    const nextConversations = sortByLatestActivity(
      cached.conversations.map((conv) =>
        conv.id === message.conversation_id
          ? {
              ...conv,
              last_message: getLastMessagePreview(message),
              last_message_at: message.created_at,
            }
          : conv,
      ),
    );
    conversationsCache.set(currentUserId, {
      conversations: nextConversations,
      totalUnread: cached.totalUnread,
      fetchedAt: Date.now(),
    });
  }

  window.dispatchEvent(new CustomEvent('kotobi:conversation-preview', { detail: { currentUserId, message } }));
};

export const useConversations = () => {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalUnread, setTotalUnread] = useState(0);

  // تحميل سريع من الكاش عند توفره
  useEffect(() => {
    if (!userId) {
      setConversations([]);
      setTotalUnread(0);
      setLoading(false);
      return;
    }

    const cached = conversationsCache.get(userId);
    if (cached) {
      setConversations(cached.conversations);
      setTotalUnread(cached.totalUnread);
      setLoading(false);
    }
  }, [userId]);

  const [botConvEnsured, setBotConvEnsured] = useState(false);

  // إنشاء محادثة مع البوت تلقائياً إذا لم تكن موجودة
  useEffect(() => {
    if (!userId || userId === KOTOBI_AI_USER_ID || botConvEnsured) return;

    const ensure = async () => {
      try {
        const { data: existing } = await supabase
          .from('conversations')
          .select('id')
          .or(
            `and(participant_1.eq.${userId},participant_2.eq.${KOTOBI_AI_USER_ID}),and(participant_1.eq.${KOTOBI_AI_USER_ID},participant_2.eq.${userId})`
          )
          .limit(1);

        if (!existing || existing.length === 0) {
          const { error } = await supabase
            .from('conversations')
            .insert({
              participant_1: userId,
              participant_2: KOTOBI_AI_USER_ID,
              last_message_at: new Date().toISOString()
            });
          if (error) {
            console.error('Failed to create bot conversation:', error);
          } else {
            console.log('✅ Bot conversation created');
          }
        }
      } catch (err) {
        console.error('Error ensuring bot conversation:', err);
      } finally {
        setBotConvEnsured(true);
      }
    };

    ensure();
  }, [userId, botConvEnsured]);

  const fetchConversations = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (!userId) return;

    const cached = conversationsCache.get(userId);
    const isFresh = !!cached && Date.now() - cached.fetchedAt < CONVERSATIONS_STALE_MS;
    if (!options?.force && isFresh) {
      return;
    }

    if (!options?.silent) {
      const hasData = (cached?.conversations?.length ?? 0) > 0;
      setLoading(!hasData);
    }

    try {

      const { data: convs, error } = await supabase
        .from('conversations')
        .select('*')
        .or(`participant_1.eq.${userId},participant_2.eq.${userId}`)
        .order('last_message_at', { ascending: false });

      if (error) throw error;

      if (!convs || convs.length === 0) {
        setConversations([]);
        setTotalUnread(0);
        conversationsCache.set(userId, { conversations: [], totalUnread: 0, fetchedAt: Date.now() });
        setLoading(false);
        return;
      }

      // جلب معلومات المستخدمين الآخرين
      const otherUserIds = convs.map(c => 
        c.participant_1 === userId ? c.participant_2 : c.participant_1
      );

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, last_seen')
        .in('id', otherUserIds);

      const conversationIds = convs.map((conv) => conv.id);
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('id, conversation_id, content, sender_id, created_at, message_type, transcript, audio_url')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false });

      const latestMessageByConversation = new Map<string, MessagePreviewRow>();
      ((recentMessages || []) as MessagePreviewRow[]).forEach((message) => {
        if (!latestMessageByConversation.has(message.conversation_id)) {
          latestMessageByConversation.set(message.conversation_id, message);
        }
      });

      // جلب آخر رسالة وعدد غير المقروءة لكل محادثة
      const enrichedConversations: Conversation[] = await Promise.all(
        convs.map(async (conv) => {
          const otherUserId = conv.participant_1 === userId ? conv.participant_2 : conv.participant_1;
          const otherUser = profiles?.find(p => p.id === otherUserId);
          const lastMessagePreview = getLastMessagePreview(latestMessageByConversation.get(conv.id));

          // عدد غير المقروءة
          const { count } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('conversation_id', conv.id)
            .eq('is_read', false)
            .neq('sender_id', userId);

          return {
            ...conv,
            other_user: otherUser ? {
              id: otherUser.id,
              username: otherUser.username,
              avatar_url: resolveKotobiAiAvatar({ userId: otherUser.id, avatarUrl: otherUser.avatar_url }),
              last_seen: otherUser.last_seen
            } : undefined,
            last_message: lastMessagePreview,
            unread_count: count || 0
          };
        })
      );

      const sortedConversations = sortByLatestActivity(enrichedConversations);
      setConversations(sortedConversations);
      const nextTotalUnread = enrichedConversations.reduce((sum, c) => sum + c.unread_count, 0);
      setTotalUnread(nextTotalUnread);

      conversationsCache.set(userId, {
        conversations: sortedConversations,
        totalUnread: nextTotalUnread,
        fetchedAt: Date.now(),
      });
    } catch (error) {
      console.error('Error fetching conversations:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // الحصول على محادثة مع مستخدم معين
  const getConversationWithUser = useCallback((targetUserId: string) => {
    return conversations.find(c => 
      c.participant_1 === targetUserId || c.participant_2 === targetUserId
    );
  }, [conversations]);

  // الاستماع للتحديثات الفورية
  useEffect(() => {
    if (!userId) return;

    // الجلب الأول أو إعادة الجلب بعد إنشاء محادثة البوت
    fetchConversations({ force: botConvEnsured });

    const channelId = `conversations_${userId}_${Math.random().toString(36).slice(2, 8)}`;
    const applyMessagePreview = (message: MessagePreviewRow) => {
      setConversations((prev) => {
        const messageConversation = prev.find((conv) => conv.id === message.conversation_id);
        if (!messageConversation) return prev;

        const next = sortByLatestActivity(
          prev.map((conv) =>
            conv.id === message.conversation_id
              ? {
                  ...conv,
                  last_message: getLastMessagePreview(message),
                  last_message_at: message.created_at,
                  unread_count:
                    message.sender_id !== userId ? conv.unread_count + 1 : conv.unread_count,
                }
              : conv,
          ),
        );
        const nextTotalUnread = next.reduce((sum, conv) => sum + conv.unread_count, 0);
        conversationsCache.set(userId, { conversations: next, totalUnread: nextTotalUnread, fetchedAt: Date.now() });
        setTotalUnread(nextTotalUnread);
        return next;
      });
    };
    const handleLocalPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ currentUserId: string; message: MessagePreviewRow }>).detail;
      if (detail?.currentUserId === userId) {
        applyMessagePreview(detail.message);
      }
    };

    window.addEventListener('kotobi:conversation-preview', handleLocalPreview);
    const channel = supabase
      .channel(channelId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations'
        },
        () => fetchConversations({ force: true, silent: true })
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages'
        },
        async (payload) => {
          applyMessagePreview(payload.new as MessagePreviewRow);
          await fetchConversations({ force: true, silent: true });
        }
      )
      .subscribe();

    return () => {
      window.removeEventListener('kotobi:conversation-preview', handleLocalPreview);
      supabase.removeChannel(channel);
    };
  }, [userId, fetchConversations, botConvEnsured]);

  return {
    conversations,
    loading,
    totalUnread,
    getConversationWithUser,
    refetch: fetchConversations
  };
};
