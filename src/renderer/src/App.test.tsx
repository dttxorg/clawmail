import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const profiles = [
  {
    id: 'profile-1',
    profileName: 'claw-test-1',
    emailAddress: 'test-1@claw.email',
    displayName: '测试邮箱 1',
    status: 'READY' as const,
    lastSyncAt: '2026-04-30T09:00:00.000Z',
    lastSyncMessage: '同步成功',
    unreadCount: 1,
    mailboxExpiresAt: null,
    guestAccessKey: {
      createdAt: '2026-04-30T09:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null
    }
  }
];

const messages = [
  {
    id: 'mail-1',
    profileId: 'profile-1',
    fromName: 'Sender',
    fromAddress: 'sender@example.com',
    subject: '测试邮件',
    receivedAt: '2026-04-30T09:10:00.000Z',
    isRead: false,
    hasAttachments: false,
    snippet: '这是测试摘要'
  }
];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body
  } as Response;
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/admin/session' && method === 'GET') {
      return jsonResponse({ username: 'admin', mustChangePassword: false });
    }
    if (url === '/api/admin/password' && method === 'PUT') {
      return jsonResponse({ ok: true, mustChangePassword: false, message: '管理员密码已更新。' });
    }
    if (url === '/api/admin/mailboxes' && method === 'GET') {
      return jsonResponse({ profiles });
    }
    if (url === '/api/admin/calendar' && method === 'GET') {
      return jsonResponse({
        items: [
          {
            type: 'key',
            profileId: 'profile-1',
            emailAddress: 'test-1@claw.email',
            displayName: '测试邮箱 1',
            expiresAt: '2026-05-30T09:00:00.000Z'
          }
        ]
      });
    }
    if (url === '/api/admin/messages' && method === 'GET') {
      return jsonResponse({ messages });
    }
    if (url === '/api/admin/messages/mail-1' && method === 'GET') {
      return jsonResponse({ ...messages[0], bodyText: '测试正文' });
    }
    if (url === '/api/admin/mailboxes' && method === 'POST') {
      return jsonResponse({
        ok: true,
        message: '导入完成：1 个成功，0 个跳过，0 个失败。',
        guestAccessKeys: [{ profileId: 'profile-1', key: 'ck_guest_test_key_12345678901234567890' }]
      }, true, 201);
    }
    if (url === '/api/admin/mailboxes/profile-1/refresh' && method === 'POST') {
      return jsonResponse({
        skipped: false,
        reason: 'REFRESHED',
        result: { ok: true, profileId: 'profile-1', syncedAt: '2026-04-30T09:20:00.000Z', message: '同步成功。' }
      });
    }
    if (url === '/api/admin/mailboxes/profile-1/guest-key' && method === 'POST') {
      return jsonResponse({ profileId: 'profile-1', key: 'ck_guest_rotated_key_123456789012345678' }, true, 201);
    }
    if (url === '/api/admin/mailboxes/profile-1/guest-key' && method === 'GET') {
      return jsonResponse({ profileId: 'profile-1', key: 'ck_guest_visible_key_123456789012345678' });
    }
    if (url === '/api/admin/mailboxes/profile-1/guest-key-expiration' && method === 'PATCH') {
      return jsonResponse({ profileId: 'profile-1', expiresAt: '2026-05-30T09:00:00.000Z' });
    }
    if (url === '/api/admin/mailboxes/profile-1/expiration' && method === 'PATCH') {
      return jsonResponse({ profileId: 'profile-1', expiresAt: '2026-05-30T09:00:00.000Z' });
    }
    if (url === '/api/admin/mailboxes/profile-1' && method === 'DELETE') {
      return jsonResponse({ ok: true, profileId: 'profile-1', message: '已删除账号 test-1@claw.email。' });
    }
    if (url === '/api/guest/session' && method === 'POST') {
      return jsonResponse({
        profile: profiles[0],
        messages,
        refresh: {
          skipped: false,
          reason: 'REFRESHED',
          result: { ok: true, profileId: 'profile-1', syncedAt: '2026-04-30T09:20:00.000Z', message: '同步成功。' }
        }
      });
    }
    if (url === '/api/guest/messages/mail-1' && method === 'GET') {
      return jsonResponse({ ...messages[0], bodyText: 'HTML 正文', bodyHtml: '<p>你好 <strong>ClawMail</strong></p><a href="https://example.com">安全链接</a><a href="javascript:alert(1)">危险链接</a><script>alert(1)</script>' });
    }

    return jsonResponse({ error: { message: `Unhandled ${method} ${url}` } }, false, 404);
  });
}

async function loginAdmin() {
  fireEvent.click(screen.getByRole('button', { name: /管理员/ }));
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'admin-password' } });
  fireEvent.click(screen.getByRole('button', { name: /登录/ }));
  await screen.findByText('测试邮件');
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch());
    document.execCommand = vi.fn(() => true);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn()
      }
    });
  });

  it('starts at the guest access screen', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '访客访问' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /进入并刷新/ })).toBeInTheDocument();
  });

  it('shows admin login after switching modes', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /管理员/ }));

    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeInTheDocument();
  });

  it('requires password change when the admin still uses the default password', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/admin/session' && method === 'GET') {
        return jsonResponse({ username: 'admin', mustChangePassword: true });
      }
      if (url === '/api/admin/password' && method === 'PUT') {
        return jsonResponse({ ok: true, message: '管理员密码已更新。' });
      }
      if (url === '/api/admin/mailboxes' && method === 'GET') return jsonResponse({ profiles });
      if (url === '/api/admin/messages' && method === 'GET') return jsonResponse({ messages });
      if (url === '/api/admin/messages/mail-1' && method === 'GET') return jsonResponse({ ...messages[0], bodyText: '测试正文' });
      return jsonResponse({ error: { message: 'Unhandled' } }, false, 404);
    }));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /管理员/ }));
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /登录/ }));

    await screen.findByRole('heading', { name: '修改默认密码' });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-admin' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-admin' } });
    fireEvent.click(screen.getByRole('button', { name: /保存新密码/ }));

    await screen.findByText('测试邮件');
  });

  it('loads the admin inbox without import or export controls', async () => {
    render(<App />);

    await loginAdmin();

    expect(screen.getByRole('heading', { name: '添加邮箱' })).toBeInTheDocument();
    expect(screen.getByText('测试邮箱 1')).toBeInTheDocument();
    expect(screen.queryByText('批量导入')).not.toBeInTheDocument();
    expect(screen.queryByText('导出')).not.toBeInTheDocument();
  });

  it('adds a mailbox and shows the generated guest key once', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await loginAdmin();

    fireEvent.change(screen.getByPlaceholderText(/Hermes 安装命令/), { target: { value: 't1/test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /添加邮箱/ }));

    await screen.findByText('新访客密钥');
    expect(screen.getByText('ck_guest_test_key_12345678901234567890')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/mailboxes', expect.objectContaining({ method: 'POST' }));
  });

  it('copies generated guest keys with feedback', async () => {
    render(<App />);
    await loginAdmin();

    fireEvent.change(screen.getByPlaceholderText(/Hermes 安装命令/), { target: { value: 't1/test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /添加邮箱/ }));
    await screen.findByText('新访客密钥');

    fireEvent.click(screen.getByRole('button', { name: '复制密钥' }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ck_guest_test_key_12345678901234567890'));
    expect(screen.getByText('访客密钥已复制到剪贴板。')).toBeInTheDocument();
  });

  it('falls back when Clipboard API is blocked', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    render(<App />);
    await loginAdmin();

    fireEvent.change(screen.getByPlaceholderText(/Hermes 安装命令/), { target: { value: 't1/test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /添加邮箱/ }));
    await screen.findByText('新访客密钥');

    fireEvent.click(screen.getByRole('button', { name: '复制密钥' }));

    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    expect(screen.getByText('访客密钥已复制到剪贴板。')).toBeInTheDocument();
  });

  it('enters guest mode and triggers a mailbox refresh immediately', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);

    fireEvent.change(screen.getByLabelText('访客密钥'), { target: { value: 'ck_guest_test_key_12345678901234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /进入并刷新/ }));

    await screen.findByText('test-1@claw.email');
    expect(screen.getAllByText('测试邮件').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/guest/session', expect.objectContaining({ method: 'POST' }));
  });

  it('sanitizes HTML mail bodies', async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText('访客密钥'), { target: { value: 'ck_guest_test_key_12345678901234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /进入并刷新/ }));

    await screen.findByText('安全链接');
    const safeLink = screen.getByRole('link', { name: '安全链接' });
    expect(safeLink).toHaveAttribute('href', 'https://example.com');
    expect(safeLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href');
    expect(document.querySelector('.mail-body script')).toBeNull();
    expect(document.querySelector('.mail-body strong')).toHaveTextContent('ClawMail');
  });

  it('refreshes, views, and resets guest keys from the admin mailbox row', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await loginAdmin();

    fireEvent.click(screen.getByRole('button', { name: '刷新邮箱' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/mailboxes/profile-1/refresh', expect.objectContaining({ method: 'POST' })));

    fireEvent.click(screen.getByRole('button', { name: '查看访客密钥' }));
    await screen.findByText('ck_guest_visible_key_123456789012345678');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/mailboxes/profile-1/guest-key', expect.objectContaining({ method: 'GET' }));

    fireEvent.click(screen.getByRole('button', { name: '重置访客密钥' }));
    await screen.findByText('ck_guest_rotated_key_123456789012345678');
  });

  it('sets key and mailbox subscription dates with quick day buttons', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await loginAdmin();

    fireEvent.click(screen.getByText('测试邮箱 1'));
    fireEvent.click(screen.getAllByText('7 天')[0]);
    fireEvent.click(screen.getByRole('button', { name: '保存密钥时间' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/mailboxes/profile-1/guest-key-expiration', expect.objectContaining({ method: 'PATCH' })));

    fireEvent.click(screen.getAllByText('30 天')[1]);
    fireEvent.click(screen.getByRole('button', { name: '保存订阅到期' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/mailboxes/profile-1/expiration', expect.objectContaining({ method: 'PATCH' })));
  });

  it('shows the calendar page with key and subscription dates', async () => {
    render(<App />);
    await loginAdmin();

    fireEvent.click(screen.getByRole('button', { name: /日历/ }));

    await screen.findByRole('heading', { name: '日期日历' });
    expect(screen.getByText('密钥有效期')).toBeInTheDocument();
    expect(screen.getAllByText(/test-1@claw.email/).length).toBeGreaterThan(0);
  });
});
