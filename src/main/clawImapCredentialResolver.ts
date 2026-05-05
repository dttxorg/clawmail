import type { MailboxProfile } from '../shared/types';
import type { SecretStore } from './secretStore';

export interface ResolvedImapCredential {
  profileId: string;
  email: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
}

export class ClawImapCredentialResolver {
  constructor(private readonly secretStore: SecretStore) {}

  async resolve(profile: MailboxProfile): Promise<ResolvedImapCredential> {
    const password = await this.secretStore.getPassword(profile.id);
    if (!password) {
      throw new Error('未找到该邮箱的本机安全凭据，请重新添加邮箱。');
    }

    return {
      profileId: profile.id,
      email: profile.emailAddress,
      password,
      host: profile.imapHost ?? 'claw.163.com',
      port: profile.imapPort ?? 993,
      secure: true
    };
  }
}
