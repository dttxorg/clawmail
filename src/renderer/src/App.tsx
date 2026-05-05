import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  KeyRound,
  Eye,
  CalendarDays,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound
} from 'lucide-react';
import type { MailDetail, MailSummary, MailboxProfile, SyncResult } from '../../shared/types';

type Mode = 'guest' | 'admin';
type AdminView = 'inbox' | 'calendar';

interface AdminCredentials {
  username: string;
  password: string;
}

interface AdminProfile extends MailboxProfile {
  guestAccessKey: {
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
  } | null;
  mailboxExpiresAt: string | null;
}

interface GuestRefresh {
  skipped: boolean;
  reason: 'REFRESHED' | 'IN_FLIGHT' | 'COOLDOWN' | 'RATE_LIMIT';
  result: SyncResult;
}

interface GuestMailboxPayload {
  profile: MailboxProfile;
  messages: MailSummary[];
  refresh?: GuestRefresh;
}

interface GeneratedGuestKey {
  profileId: string;
  key: string;
  expiresAt?: string | null;
}

interface AdminSession {
  username: string;
  mustChangePassword: boolean;
}

interface CalendarItem {
  type: 'key' | 'mailbox';
  profileId: string;
  emailAddress: string;
  displayName: string;
  expiresAt: string;
}

interface ApiErrorBody {
  error?: {
    message?: string;
  };
}

const initialGuestKey = decodeURIComponent(window.location.pathname.match(/^\/guest\/([^/]+)$/)?.[1] ?? '');

function formatDate(value: string | null): string {
  if (!value) return '未同步';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatFullDate(value: string | null): string {
  if (!value) return '不限';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatCountdown(value: string | null): string {
  if (!value) return '不限';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '时间无效';
  const days = Math.ceil((time - Date.now()) / 86_400_000);
  if (days > 0) return `剩余 ${days} 天`;
  if (days === 0) return '今天到期';
  return `已到期 ${Math.abs(days)} 天`;
}

function formatDateTimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoFromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysFromNowLocal(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatDateTimeLocal(date.toISOString());
}

function dateKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-01`;
}

function addMonths(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setMonth(date.getMonth() + amount);
  return monthKey(date);
}

function formatMonthTitle(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long'
  }).format(new Date(`${value}T00:00:00`));
}

function buildCalendarDays(value: string): Array<{ key: string; day: number; inMonth: boolean }> {
  const first = new Date(`${value}T00:00:00`);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: dateKey(date),
      day: date.getDate(),
      inMonth: date.getMonth() === first.getMonth()
    };
  });
}

function basicAuth(credentials: AdminCredentials): string {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

async function requestJson<T>(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    admin?: AdminCredentials;
    guestKey?: string;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json'
  };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.admin) headers.authorization = basicAuth(options.admin);
  if (options.guestKey) headers['x-guest-key'] = options.guestKey;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.error?.message || '请求失败。');
  }
  return body as T;
}

function sanitizeMailHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'p', 'div', 'span', 'br', 'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i', 'hr', 'pre', 'code', 'h1', 'h2', 'h3', 'h4'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'align', 'valign', 'style', 'class', 'target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|cid):|data:image\/(?:png|gif|jpeg|jpg|webp);base64,)/i
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  for (const anchor of template.content.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      continue;
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return template.innerHTML;
}

async function copyTextToClipboard(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      // Fall back below for browsers that block Clipboard API on non-HTTPS origins.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('浏览器阻止了自动复制，请手动选中密钥复制。');
  }
}

export function App() {
  const [mode, setMode] = useState<Mode>('guest');
  const [admin, setAdmin] = useState<AdminCredentials>({ username: 'admin', password: '' });
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [adminView, setAdminView] = useState<AdminView>('inbox');
  const [timeEditorProfileId, setTimeEditorProfileId] = useState<string | null>(null);
  const [calendarCursor, setCalendarCursor] = useState(monthKey(new Date()));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(dateKey(new Date()));
  const [guestKey, setGuestKey] = useState(initialGuestKey);
  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [calendarItems, setCalendarItems] = useState<CalendarItem[]>([]);
  const [guestProfile, setGuestProfile] = useState<MailboxProfile | null>(null);
  const [messages, setMessages] = useState<MailSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('all');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailDetail | null>(null);
  const [messageDetails, setMessageDetails] = useState<Record<string, MailDetail>>({});
  const [authUrl, setAuthUrl] = useState('');
  const [generatedKeys, setGeneratedKeys] = useState<GeneratedGuestKey[]>([]);
  const [keyExpiresAtDraft, setKeyExpiresAtDraft] = useState('');
  const [mailboxExpiresAtDraft, setMailboxExpiresAtDraft] = useState('');
  const [notice, setNotice] = useState('Docker Web 模式：不会后台刷新全部邮箱，只有管理员手动刷新或访客密钥访问时刷新对应邮箱。');
  const [isBusy, setIsBusy] = useState(false);
  const detailRequestsRef = useRef<Record<string, Promise<MailDetail>>>({});

  const visibleMessages = useMemo(() => {
    if (mode === 'guest' || selectedProfileId === 'all') return messages;
    return messages.filter((message) => message.profileId === selectedProfileId);
  }, [messages, mode, selectedProfileId]);
  const activeProfile = mode === 'guest' ? guestProfile : profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const timeEditorProfile = profiles.find((profile) => profile.id === timeEditorProfileId) ?? null;
  const sanitizedBodyHtml = useMemo(() => (selectedMessage?.bodyHtml ? sanitizeMailHtml(selectedMessage.bodyHtml) : ''), [selectedMessage?.bodyHtml]);
  const calendarDays = useMemo(() => buildCalendarDays(calendarCursor), [calendarCursor]);
  const calendarItemsByDate = useMemo(() => {
    const groups = new Map<string, CalendarItem[]>();
    for (const item of calendarItems) {
      const key = dateKey(item.expiresAt);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return groups;
  }, [calendarItems]);
  const selectedCalendarItems = calendarItemsByDate.get(selectedCalendarDate) ?? [];

  async function loadAdminData(credentials = admin) {
    const [{ profiles: nextProfiles }, { messages: nextMessages }] = await Promise.all([
      requestJson<{ profiles: AdminProfile[] }>('/api/admin/mailboxes', { admin: credentials }),
      requestJson<{ messages: MailSummary[] }>('/api/admin/messages', { admin: credentials })
    ]);
    setProfiles(nextProfiles);
    setMessages(nextMessages);
    setSelectedMessageId((current) => current ?? nextMessages[0]?.id ?? null);
  }

  async function loadCalendar(credentials = admin) {
    const result = await requestJson<{ items: CalendarItem[] }>('/api/admin/calendar', { admin: credentials });
    setCalendarItems(result.items);
  }

  async function switchAdminView(view: AdminView) {
    setAdminView(view);
    if (view === 'calendar') {
      setTimeEditorProfileId(null);
      try {
        await loadCalendar();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '读取日历失败。');
      }
    }
  }

  function openTimeEditor(profile: AdminProfile) {
    setAdminView('inbox');
    setSelectedProfileId(profile.id);
    setTimeEditorProfileId(profile.id);
  }

  async function signInAdmin() {
    setIsBusy(true);
    try {
      const session = await requestJson<AdminSession>('/api/admin/session', { admin });
      setIsAdminAuthenticated(true);
      setMustChangePassword(session.mustChangePassword);
      setPasswordForm({ currentPassword: admin.password, newPassword: '', confirmPassword: '' });
      setMode('admin');
      if (session.mustChangePassword) {
        setNotice('首次登录请修改默认管理员密码。');
      } else {
        await loadAdminData(admin);
        setNotice('管理员已登录。');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '管理员登录失败。');
    } finally {
      setIsBusy(false);
    }
  }

  async function changeAdminPassword() {
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setNotice('两次输入的新密码不一致。');
      return;
    }

    setIsBusy(true);
    try {
      await requestJson<{ ok: boolean; message: string }>('/api/admin/password', {
        method: 'PUT',
        body: {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword
        },
        admin
      });
      const nextAdmin = { ...admin, password: passwordForm.newPassword };
      setAdmin(nextAdmin);
      setMustChangePassword(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      await loadAdminData(nextAdmin);
      setNotice('管理员密码已更新。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '修改密码失败。');
    } finally {
      setIsBusy(false);
    }
  }

  async function enterGuest() {
    setIsBusy(true);
    try {
      const payload = await requestJson<GuestMailboxPayload>('/api/guest/session', {
        method: 'POST',
        body: { accessKey: guestKey.trim() }
      });
      setMode('guest');
      setGuestProfile(payload.profile);
      setMessages(payload.messages);
      setSelectedMessageId(payload.messages[0]?.id ?? null);
      setNotice(payload.refresh?.result.message ?? '密钥验证成功，已读取邮箱。');
    } catch (error) {
      setGuestProfile(null);
      setMessages([]);
      setNotice(error instanceof Error ? error.message : '密钥访问失败。');
    } finally {
      setIsBusy(false);
    }
  }

  async function addMailbox() {
    if (!authUrl.trim()) {
      setNotice('请先粘贴 ClawEmail Hermes 安装命令或 auth-url。');
      return;
    }

    setIsBusy(true);
    try {
      const result = await requestJson<{ ok: boolean; message: string; guestAccessKeys?: GeneratedGuestKey[] }>('/api/admin/mailboxes', {
        method: 'POST',
        body: { authUrl },
        admin
      });
      setAuthUrl('');
      setGeneratedKeys(result.guestAccessKeys ?? []);
      await loadAdminData();
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '添加邮箱失败。');
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshProfile(profileId: string, guest = false) {
    setIsBusy(true);
    try {
      if (guest) {
        const payload = await requestJson<GuestMailboxPayload>('/api/guest/refresh', {
          method: 'POST',
          guestKey
        });
        setGuestProfile(payload.profile);
        setMessages(payload.messages);
        setNotice(payload.refresh?.result.message ?? '刷新完成。');
      } else {
        const refresh = await requestJson<GuestRefresh>(`/api/admin/mailboxes/${encodeURIComponent(profileId)}/refresh`, {
          method: 'POST',
          admin
        });
        await loadAdminData();
        setNotice(refresh.result.message);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新失败。');
    } finally {
      setIsBusy(false);
    }
  }

  async function rotateGuestKey(profileId: string) {
    try {
      const result = await requestJson<GeneratedGuestKey>(`/api/admin/mailboxes/${encodeURIComponent(profileId)}/guest-key`, {
        method: 'POST',
        admin,
        body: { expiresAt: toIsoFromDateTimeLocal(keyExpiresAtDraft) }
      });
      setGeneratedKeys([result]);
      await loadAdminData();
      setNotice('访客密钥已重置，新密钥只显示这一次。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重置密钥失败。');
    }
  }

  async function updateKeyExpiration(profileId: string) {
    try {
      await requestJson(`/api/admin/mailboxes/${encodeURIComponent(profileId)}/guest-key-expiration`, {
        method: 'PATCH',
        admin,
        body: { expiresAt: toIsoFromDateTimeLocal(keyExpiresAtDraft) }
      });
      await Promise.all([loadAdminData(), loadCalendar()]);
      setNotice('访客密钥有效期已更新。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '更新密钥有效期失败。');
    }
  }

  async function updateMailboxExpiration(profileId: string) {
    try {
      await requestJson(`/api/admin/mailboxes/${encodeURIComponent(profileId)}/expiration`, {
        method: 'PATCH',
        admin,
        body: { expiresAt: toIsoFromDateTimeLocal(mailboxExpiresAtDraft) }
      });
      await Promise.all([loadAdminData(), loadCalendar()]);
      setNotice('邮箱订阅到期时间已更新。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '更新邮箱订阅到期时间失败。');
    }
  }

  async function viewGuestKey(profileId: string) {
    try {
      const result = await requestJson<GeneratedGuestKey>(`/api/admin/mailboxes/${encodeURIComponent(profileId)}/guest-key`, {
        admin
      });
      setGeneratedKeys([result]);
      setNotice('已显示完整访客密钥，可直接复制。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '查看密钥失败。');
    }
  }

  async function deleteProfile(profile: AdminProfile) {
    if (!window.confirm(`删除邮箱 ${profile.emailAddress}？本地缓存和加密凭据会一并删除。`)) return;

    try {
      const result = await requestJson<{ ok: boolean; message: string }>(`/api/admin/mailboxes/${encodeURIComponent(profile.id)}`, {
        method: 'DELETE',
        admin
      });
      await loadAdminData();
      if (selectedProfileId === profile.id) setSelectedProfileId('all');
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除邮箱失败。');
    }
  }

  async function copyGuestKey(key: string) {
    try {
      await copyTextToClipboard(key);
      setNotice('访客密钥已复制到剪贴板。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '复制失败，请手动选中密钥复制。');
    }
  }

  function requestMessageDetail(messageId: string): Promise<MailDetail> {
    const requestKey = `${mode}:${messageId}`;
    const running = detailRequestsRef.current[requestKey];
    if (running) return running;

    const path = mode === 'guest' ? `/api/guest/messages/${encodeURIComponent(messageId)}` : `/api/admin/messages/${encodeURIComponent(messageId)}`;
    const promise = requestJson<MailDetail>(path, mode === 'guest' ? { guestKey } : { admin })
      .then((detail) => {
        setMessageDetails((current) => (current[detail.id] ? current : { ...current, [detail.id]: detail }));
        return detail;
      })
      .finally(() => {
        delete detailRequestsRef.current[requestKey];
      });
    detailRequestsRef.current[requestKey] = promise;
    return promise;
  }

  useEffect(() => {
    if (initialGuestKey) void enterGuest();
  }, []);

  useEffect(() => {
    if (mode !== 'admin' || !timeEditorProfile) return;
    setKeyExpiresAtDraft(formatDateTimeLocal(timeEditorProfile.guestAccessKey?.expiresAt));
    setMailboxExpiresAtDraft(formatDateTimeLocal(timeEditorProfile.mailboxExpiresAt));
  }, [mode, timeEditorProfile?.id, profiles]);

  useEffect(() => {
    if (!selectedMessageId) {
      setSelectedMessage(null);
      return;
    }

    const cachedDetail = messageDetails[selectedMessageId];
    if (cachedDetail) {
      setSelectedMessage(cachedDetail);
      return;
    }

    const summary = messages.find((message) => message.id === selectedMessageId);
    if (summary) {
      setSelectedMessage({
        ...summary,
        bodyText: '正在读取邮件正文...'
      });
    }

    let cancelled = false;
    void requestMessageDetail(selectedMessageId)
      .then((detail) => {
        if (cancelled) return;
        setSelectedMessage(detail);
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedMessage(null);
        setNotice(error instanceof Error ? error.message : '读取邮件详情失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMessageId, mode, messages, messageDetails, guestKey]);

  useEffect(() => {
    if (mode !== 'guest' || !selectedMessageId) return;
    const currentIndex = visibleMessages.findIndex((message) => message.id === selectedMessageId);
    if (currentIndex < 0) return;
    const nearbyIds = [currentIndex + 1, currentIndex - 1, currentIndex + 2]
      .map((index) => visibleMessages[index]?.id)
      .filter((id): id is string => Boolean(id));
    for (const id of nearbyIds) {
      if (!messageDetails[id]) void requestMessageDetail(id).catch(() => undefined);
    }
  }, [selectedMessageId, visibleMessages, mode, messageDetails, guestKey]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ClawMail</h1>
          <p>按密钥访问的 ClawEmail Docker 收件箱</p>
        </div>
        <div className="mode-switch" aria-label="访问模式">
          <button className={mode === 'admin' ? 'active' : ''} type="button" onClick={() => setMode('admin')}>
            <ShieldCheck size={16} aria-hidden="true" />
            管理员
          </button>
          <button className={mode === 'guest' ? 'active' : ''} type="button" onClick={() => setMode('guest')}>
            <UserRound size={16} aria-hidden="true" />
            访客
          </button>
        </div>
      </header>

      <section className="notice" role="status">{notice}</section>

      {mode === 'admin' && !isAdminAuthenticated ? (
        <section className="auth-panel" aria-label="管理员登录">
          <Lock size={24} aria-hidden="true" />
          <h2>管理员登录</h2>
          <label htmlFor="admin-user">账号</label>
          <input id="admin-user" value={admin.username} onChange={(event) => setAdmin({ ...admin, username: event.target.value })} />
          <label htmlFor="admin-password">密码</label>
          <input id="admin-password" type="password" value={admin.password} onChange={(event) => setAdmin({ ...admin, password: event.target.value })} />
          <button className="button primary" type="button" onClick={signInAdmin} disabled={isBusy}>
            <ShieldCheck size={16} aria-hidden="true" />
            登录
          </button>
        </section>
      ) : mode === 'admin' && isAdminAuthenticated && mustChangePassword ? (
        <section className="auth-panel" aria-label="修改管理员密码">
          <Lock size={24} aria-hidden="true" />
          <h2>修改默认密码</h2>
          <p>默认管理员账号和密码都是 admin。首次登录后请先设置新密码。</p>
          <label htmlFor="current-password">当前密码</label>
          <input id="current-password" type="password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} />
          <label htmlFor="new-password">新密码</label>
          <input id="new-password" type="password" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} />
          <label htmlFor="confirm-password">确认新密码</label>
          <input id="confirm-password" type="password" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })} />
          <button className="button primary" type="button" onClick={changeAdminPassword} disabled={isBusy}>
            <ShieldCheck size={16} aria-hidden="true" />
            保存新密码
          </button>
        </section>
      ) : mode === 'guest' && !guestProfile ? (
        <section className="auth-panel" aria-label="访客密钥访问">
          <KeyRound size={24} aria-hidden="true" />
          <h2>访客访问</h2>
          <p>输入邮箱对应密钥后，会立即刷新该邮箱；其他邮箱不会被触发。</p>
          <label htmlFor="guest-key">访客密钥</label>
          <input id="guest-key" value={guestKey} onChange={(event) => setGuestKey(event.target.value)} placeholder="ck_guest_xxx" />
          <button className="button primary" type="button" onClick={enterGuest} disabled={isBusy}>
            <RefreshCw size={16} aria-hidden="true" className={isBusy ? 'spin' : ''} />
            进入并刷新
          </button>
        </section>
      ) : (
        <section className="workspace">
          <aside className="sidebar" aria-label="邮箱列表">
            {mode === 'admin' ? (
              <>
                <div className="admin-tabs" aria-label="管理视图">
                  <button className={adminView === 'inbox' ? 'active' : ''} type="button" onClick={() => void switchAdminView('inbox')}>
                    <Mail size={15} aria-hidden="true" />
                    邮箱
                  </button>
                  <button className={adminView === 'calendar' ? 'active' : ''} type="button" onClick={() => void switchAdminView('calendar')}>
                    <CalendarDays size={15} aria-hidden="true" />
                    日历
                  </button>
                </div>

                <section className="add-mailbox">
                  <h2>添加邮箱</h2>
                  <textarea
                    value={authUrl}
                    onChange={(event) => setAuthUrl(event.target.value)}
                    placeholder={'粘贴 ClawEmail Hermes 安装命令或 t1/ 开头 auth-url'}
                    rows={5}
                  />
                  <button className="button primary full" type="button" onClick={addMailbox} disabled={isBusy}>
                    <Plus size={16} aria-hidden="true" />
                    添加邮箱
                  </button>
                </section>

                {generatedKeys.length > 0 && (
                  <section className="generated-key">
                    <h2>新访客密钥</h2>
                    {generatedKeys.map((item) => (
                      <div key={`${item.profileId}-${item.key}`}>
                        <code>{item.key}</code>
                        <button className="icon-button" type="button" onClick={() => void copyGuestKey(item.key)} aria-label="复制密钥" title="复制密钥">
                          <Copy size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    <small>完整密钥可复制；如设置有效期，到期后访客将无法进入。</small>
                  </section>
                )}

                {timeEditorProfile && (
                  <section className="validity-panel">
                    <div className="validity-heading">
                      <Clock3 size={16} aria-hidden="true" />
                      <div>
                        <h2>时间管理</h2>
                        <small>{timeEditorProfile.displayName} · {timeEditorProfile.emailAddress}</small>
                      </div>
                    </div>
                    <label htmlFor="key-expires-at">密钥有效时间</label>
                    <input id="key-expires-at" type="datetime-local" value={keyExpiresAtDraft} onChange={(event) => setKeyExpiresAtDraft(event.target.value)} />
                    <div className="quick-days">
                      {[7, 14, 30].map((days) => (
                        <button type="button" key={`key-${days}`} onClick={() => setKeyExpiresAtDraft(daysFromNowLocal(days))}>
                          {days} 天
                        </button>
                      ))}
                      <button type="button" onClick={() => setKeyExpiresAtDraft('')}>不限</button>
                    </div>
                    <button className="button secondary full" type="button" onClick={() => updateKeyExpiration(timeEditorProfile.id)}>
                      保存密钥时间
                    </button>

                    <label htmlFor="mailbox-expires-at">邮箱订阅到期时间</label>
                    <input id="mailbox-expires-at" type="datetime-local" value={mailboxExpiresAtDraft} onChange={(event) => setMailboxExpiresAtDraft(event.target.value)} />
                    <small>{formatCountdown(toIsoFromDateTimeLocal(mailboxExpiresAtDraft))}</small>
                    <div className="quick-days">
                      {[7, 14, 30].map((days) => (
                        <button type="button" key={`mailbox-${days}`} onClick={() => setMailboxExpiresAtDraft(daysFromNowLocal(days))}>
                          {days} 天
                        </button>
                      ))}
                      <button type="button" onClick={() => setMailboxExpiresAtDraft('')}>不限</button>
                    </div>
                    <button className="button secondary full" type="button" onClick={() => updateMailboxExpiration(timeEditorProfile.id)}>
                      保存订阅到期
                    </button>
                  </section>
                )}

                {adminView === 'inbox' ? (
                  <>
                    <button className={`nav-row ${selectedProfileId === 'all' ? 'active' : ''}`} type="button" onClick={() => setSelectedProfileId('all')}>
                      <Mail size={17} aria-hidden="true" />
                      <span>全部缓存邮件</span>
                      <strong>{messages.length}</strong>
                    </button>
                    {profiles.map((profile) => (
                      <div className={`profile-row ${selectedProfileId === profile.id ? 'active' : ''}`} key={profile.id}>
                        <button className="profile-select" type="button" onClick={() => setSelectedProfileId(profile.id)}>
                          <span className={`status-dot ${profile.status.toLowerCase()}`} />
                          <span>
                            <strong>{profile.displayName}</strong>
                            <small>{profile.emailAddress}</small>
                            <small>最后同步：{formatDate(profile.lastSyncAt)}</small>
                            <small>订阅到期：{formatFullDate(profile.mailboxExpiresAt)} · {formatCountdown(profile.mailboxExpiresAt)}</small>
                          </span>
                        </button>
                        <div className="profile-actions">
                          <button className="icon-button" type="button" onClick={() => refreshProfile(profile.id)} aria-label="刷新邮箱" title="刷新邮箱">
                            <RefreshCw size={15} aria-hidden="true" />
                          </button>
                          <button className="icon-button" type="button" onClick={() => viewGuestKey(profile.id)} aria-label="查看访客密钥" title="查看访客密钥">
                            <Eye size={15} aria-hidden="true" />
                          </button>
                          <button className="icon-button" type="button" onClick={() => rotateGuestKey(profile.id)} aria-label="重置访客密钥" title="重置访客密钥">
                            <KeyRound size={15} aria-hidden="true" />
                          </button>
                          <button className="icon-button" type="button" onClick={() => openTimeEditor(profile)} aria-label="时间管理" title="时间管理">
                            <Clock3 size={15} aria-hidden="true" />
                          </button>
                          <button className="icon-button danger" type="button" onClick={() => deleteProfile(profile)} aria-label="删除邮箱" title="删除邮箱">
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              guestProfile && (
                <section className="guest-profile">
                  <CheckCircle2 size={22} aria-hidden="true" />
                  <h2>{guestProfile.displayName}</h2>
                  <p>{guestProfile.emailAddress}</p>
                  <small>最后同步：{formatDate(guestProfile.lastSyncAt)}</small>
                  <button className="button primary full" type="button" onClick={() => refreshProfile(guestProfile.id, true)} disabled={isBusy}>
                    <RefreshCw size={16} aria-hidden="true" className={isBusy ? 'spin' : ''} />
                    手动刷新
                  </button>
                </section>
              )
            )}
          </aside>

          {mode === 'admin' && adminView === 'calendar' ? (
            <section className="calendar-board" aria-label="到期日历">
              <div className="calendar-toolbar">
                <button className="icon-button" type="button" onClick={() => setCalendarCursor(addMonths(calendarCursor, -1))} aria-label="上个月" title="上个月">
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <div>
                  <h2>到期日历</h2>
                  <p>{formatMonthTitle(calendarCursor)}</p>
                </div>
                <button className="icon-button" type="button" onClick={() => setCalendarCursor(addMonths(calendarCursor, 1))} aria-label="下个月" title="下个月">
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
              <div className="calendar-grid">
                {['日', '一', '二', '三', '四', '五', '六'].map((weekday) => (
                  <span className="calendar-weekday" key={weekday}>{weekday}</span>
                ))}
                {calendarDays.map((day) => {
                  const dayItems = calendarItemsByDate.get(day.key) ?? [];
                  return (
                    <button
                      className={`calendar-day ${day.inMonth ? '' : 'muted'} ${selectedCalendarDate === day.key ? 'active' : ''}`}
                      type="button"
                      key={day.key}
                      onClick={() => setSelectedCalendarDate(day.key)}
                    >
                      <strong>{day.day}</strong>
                      {dayItems.length > 0 && <span>{dayItems.length} 项到期</span>}
                      {dayItems.slice(0, 2).map((item) => (
                        <small key={`${item.type}-${item.profileId}-${item.expiresAt}`}>{item.type === 'key' ? '密钥' : '订阅'} · {item.displayName}</small>
                      ))}
                    </button>
                  );
                })}
              </div>
              <aside className="calendar-day-detail" aria-label="当日到期账号">
                <h3>{selectedCalendarDate} 到期</h3>
                {selectedCalendarItems.length === 0 ? (
                  <p className="empty-copy">这一天没有密钥或邮箱订阅到期。</p>
                ) : (
                  selectedCalendarItems.map((item) => (
                    <button
                      className="calendar-event"
                      type="button"
                      key={`${item.type}-${item.profileId}-${item.expiresAt}`}
                      onClick={() => {
                        const profile = profiles.find((profileItem) => profileItem.id === item.profileId);
                        if (profile) openTimeEditor(profile);
                      }}
                    >
                      <span>{item.type === 'key' ? '密钥有效期' : '邮箱订阅到期'}</span>
                      <strong>{item.displayName}</strong>
                      <small>{item.emailAddress} · {formatFullDate(item.expiresAt)} · {formatCountdown(item.expiresAt)}</small>
                    </button>
                  ))
                )}
              </aside>
            </section>
          ) : (
            <>
              <section className="message-list" aria-label="邮件列表">
                <div className="panel-header">
                  <div>
                    <h2>{activeProfile?.displayName ?? '缓存邮件'}</h2>
                    <p>{visibleMessages.length} 封邮件</p>
                  </div>
                </div>
                <div className="messages">
                  {visibleMessages.map((message) => (
                    <button
                      type="button"
                      className={`message-row ${message.id === selectedMessageId ? 'active' : ''} ${message.isRead ? 'read' : 'unread'}`}
                      key={message.id}
                      onClick={() => setSelectedMessageId(message.id)}
                      onMouseEnter={() => {
                        if (mode === 'guest' && !messageDetails[message.id]) void requestMessageDetail(message.id).catch(() => undefined);
                      }}
                    >
                      <span className="message-sender">{message.fromName}</span>
                      <span className="message-time">{formatDate(message.receivedAt)}</span>
                      <span className="message-subject">{message.subject}</span>
                      <span className="message-snippet">{message.snippet}</span>
                    </button>
                  ))}
                  {visibleMessages.length === 0 && <p className="empty-copy">还没有缓存邮件，刷新邮箱后会显示在这里。</p>}
                </div>
              </section>

              <section className="detail-pane" aria-label="邮件详情">
                {selectedMessage ? (
                  <>
                    <div className="detail-header">
                      <Mail size={20} aria-hidden="true" />
                      <div>
                        <h2>{selectedMessage.subject}</h2>
                        <p>{selectedMessage.fromName} &lt;{selectedMessage.fromAddress}&gt;</p>
                      </div>
                    </div>
                    <dl className="detail-meta">
                      <div>
                        <dt>时间</dt>
                        <dd>{formatDate(selectedMessage.receivedAt)}</dd>
                      </div>
                      <div>
                        <dt>来源邮箱</dt>
                        <dd>{activeProfile?.emailAddress ?? profiles.find((profile) => profile.id === selectedMessage.profileId)?.emailAddress ?? '未知'}</dd>
                      </div>
                    </dl>
                    {sanitizedBodyHtml ? (
                      <article className="mail-body html" dangerouslySetInnerHTML={{ __html: sanitizedBodyHtml }} />
                    ) : (
                      <article className="mail-body plain">{selectedMessage.bodyText}</article>
                    )}
                  </>
                ) : (
                  <div className="empty-state">
                    <Mail size={28} aria-hidden="true" />
                    <p>选择一封邮件查看正文。</p>
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      )}
    </main>
  );
}
