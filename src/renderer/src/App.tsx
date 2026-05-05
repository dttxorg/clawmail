import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  CheckCircle2,
  Copy,
  KeyRound,
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

interface AdminCredentials {
  username: string;
  password: string;
}

interface AdminProfile extends MailboxProfile {
  guestAccessKey: {
    createdAt: string;
    lastUsedAt: string | null;
  } | null;
}

interface GuestRefresh {
  skipped: boolean;
  reason: 'REFRESHED' | 'IN_FLIGHT' | 'COOLDOWN';
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
  const [mode, setMode] = useState<Mode>(initialGuestKey ? 'guest' : 'admin');
  const [admin, setAdmin] = useState<AdminCredentials>({ username: 'admin', password: '' });
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [guestKey, setGuestKey] = useState(initialGuestKey);
  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [guestProfile, setGuestProfile] = useState<MailboxProfile | null>(null);
  const [messages, setMessages] = useState<MailSummary[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('all');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailDetail | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [generatedKeys, setGeneratedKeys] = useState<GeneratedGuestKey[]>([]);
  const [notice, setNotice] = useState('Docker Web 模式：不会后台刷新全部邮箱，只有管理员手动刷新或访客密钥访问时刷新对应邮箱。');
  const [isBusy, setIsBusy] = useState(false);

  const visibleMessages = useMemo(() => {
    if (mode === 'guest' || selectedProfileId === 'all') return messages;
    return messages.filter((message) => message.profileId === selectedProfileId);
  }, [messages, mode, selectedProfileId]);
  const activeProfile = mode === 'guest' ? guestProfile : profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const sanitizedBodyHtml = selectedMessage?.bodyHtml ? sanitizeMailHtml(selectedMessage.bodyHtml) : '';

  async function loadAdminData(credentials = admin) {
    const [{ profiles: nextProfiles }, { messages: nextMessages }] = await Promise.all([
      requestJson<{ profiles: AdminProfile[] }>('/api/admin/mailboxes', { admin: credentials }),
      requestJson<{ messages: MailSummary[] }>('/api/admin/messages', { admin: credentials })
    ]);
    setProfiles(nextProfiles);
    setMessages(nextMessages);
    setSelectedMessageId((current) => current ?? nextMessages[0]?.id ?? null);
  }

  async function signInAdmin() {
    setIsBusy(true);
    try {
      await loadAdminData(admin);
      setIsAdminAuthenticated(true);
      setMode('admin');
      setNotice('管理员已登录。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '管理员登录失败。');
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
        admin
      });
      setGeneratedKeys([result]);
      await loadAdminData();
      setNotice('访客密钥已重置，新密钥只显示这一次。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重置密钥失败。');
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

  useEffect(() => {
    if (initialGuestKey) void enterGuest();
  }, []);

  useEffect(() => {
    if (!selectedMessageId) {
      setSelectedMessage(null);
      return;
    }

    const path = mode === 'guest' ? `/api/guest/messages/${encodeURIComponent(selectedMessageId)}` : `/api/admin/messages/${encodeURIComponent(selectedMessageId)}`;
    void requestJson<MailDetail>(path, mode === 'guest' ? { guestKey } : { admin })
      .then(setSelectedMessage)
      .catch((error) => {
        setSelectedMessage(null);
        setNotice(error instanceof Error ? error.message : '读取邮件详情失败。');
      });
  }, [selectedMessageId, mode]);

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
                        <button className="icon-button" type="button" onClick={() => void copyGuestKey(item.key)} aria-label="复制密钥">
                          <Copy size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    <small>密钥只显示这一次，丢失后请重置。</small>
                  </section>
                )}

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
                      </span>
                    </button>
                    <div className="profile-actions">
                      <button className="icon-button" type="button" onClick={() => refreshProfile(profile.id)} aria-label="刷新邮箱">
                        <RefreshCw size={15} aria-hidden="true" />
                      </button>
                      <button className="icon-button" type="button" onClick={() => rotateGuestKey(profile.id)} aria-label="重置访客密钥">
                        <KeyRound size={15} aria-hidden="true" />
                      </button>
                      <button className="icon-button danger" type="button" onClick={() => deleteProfile(profile)} aria-label="删除邮箱">
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
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
        </section>
      )}
    </main>
  );
}
