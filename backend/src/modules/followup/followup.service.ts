import { Injectable } from '@nestjs/common';
import { FollowUpStatus } from '../common/types';

export type LifecycleStatus = 'ACTIVE' | 'NEEDS_ATTENTION' | 'RESOLVED' | 'ARCHIVED';

export interface FollowUpResult {
  followUpRequired: boolean;
  followUpStatus: FollowUpStatus;
  lifecycleStatus: LifecycleStatus;
  delayHours: number;
  shortReason: string;
}

@Injectable()
export class FollowupService {
  detectFollowUpRequired(
    lastClientMsgAt: Date | null,
    lastEmployeeReplyAt: Date | null,
  ): boolean {
    if (!lastClientMsgAt) return false;
    if (!lastEmployeeReplyAt) return true;
    return lastClientMsgAt > lastEmployeeReplyAt;
  }

  computeDelayHours(lastClientMsgAt: Date | null, lastEmployeeReplyAt: Date | null): number {
    if (!lastClientMsgAt) return 0;

    const end =
      lastEmployeeReplyAt && lastEmployeeReplyAt > lastClientMsgAt
        ? lastEmployeeReplyAt
        : new Date();

    const ms = Math.max(0, end.getTime() - lastClientMsgAt.getTime());
    return Math.round((ms / (1000 * 60 * 60)) * 100) / 100;
  }

  classifyStatus(
    followUpRequired: boolean,
    lastClientMsgAt: Date | null,
    lastEmployeeReplyAt: Date | null,
    slaHours: number,
  ): FollowUpStatus {
    if (!followUpRequired) return 'DONE';

    if (lastEmployeeReplyAt && lastClientMsgAt && lastEmployeeReplyAt >= lastClientMsgAt) {
      const replyDelay = this.computeDelayHours(lastClientMsgAt, lastEmployeeReplyAt);
      return replyDelay <= slaHours ? 'DONE' : 'MISSED';
    }

    const openDelay = this.computeDelayHours(lastClientMsgAt, null);
    return openDelay > slaHours ? 'MISSED' : 'PENDING';
  }

  deriveLifecycle(
    followUpRequired: boolean,
    followUpStatus: FollowUpStatus,
    manuallyClosed: boolean,
  ): LifecycleStatus {
    if (manuallyClosed) return 'RESOLVED';
    if (followUpRequired && (followUpStatus === 'MISSED' || followUpStatus === 'PENDING')) {
      return 'NEEDS_ATTENTION';
    }
    if (followUpStatus === 'DONE') return 'RESOLVED';
    return 'ACTIVE';
  }

  generateShortReason(
    followUpRequired: boolean,
    followUpStatus: FollowUpStatus,
    delayHours: number,
    slaHours: number,
    lastClientMsgAt: Date | null,
    lastEmployeeReplyAt: Date | null,
  ): string {
    if (!lastClientMsgAt) return 'No client messages in this thread.';

    const ago = this.formatAgo(lastClientMsgAt);

    if (!followUpRequired) {
      if (lastEmployeeReplyAt) {
        return `Employee replied ${this.formatAgo(lastEmployeeReplyAt)}. No pending follow-up.`;
      }
      return 'No follow-up required.';
    }

    if (followUpStatus === 'MISSED') {
      if (lastEmployeeReplyAt && lastEmployeeReplyAt >= lastClientMsgAt) {
        return `Employee replied after ${Math.round(delayHours)}h (SLA: ${slaHours}h). Late response.`;
      }
      return `Client sent message ${ago}. No reply. SLA ${slaHours}h exceeded by ${Math.round(delayHours - slaHours)}h.`;
    }

    if (followUpStatus === 'PENDING') {
      return `Client sent message ${ago}. Awaiting reply. ${Math.round(slaHours - delayHours)}h remaining before SLA breach.`;
    }

    return `Conversation status: ${followUpStatus}.`;
  }

  /**
   * Compute a full FollowUpResult in one call — used by ConversationsService.
   */
  analyze(
    lastClientMsgAt: Date | null,
    lastEmployeeReplyAt: Date | null,
    slaHours: number,
    manuallyClosed: boolean,
  ): FollowUpResult {
    const followUpRequired = this.detectFollowUpRequired(lastClientMsgAt, lastEmployeeReplyAt);
    const delayHours = this.computeDelayHours(lastClientMsgAt, lastEmployeeReplyAt);
    const followUpStatus = this.classifyStatus(followUpRequired, lastClientMsgAt, lastEmployeeReplyAt, slaHours);
    const lifecycleStatus = this.deriveLifecycle(followUpRequired, followUpStatus, manuallyClosed);
    const shortReason = this.generateShortReason(
      followUpRequired, followUpStatus, delayHours, slaHours, lastClientMsgAt, lastEmployeeReplyAt,
    );
    return { followUpRequired, followUpStatus, lifecycleStatus, delayHours, shortReason };
  }

  private formatAgo(date: Date): string {
    const diffH = Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60));
    if (diffH < 1) return 'just now';
    if (diffH < 24) return `${diffH}h ago`;
    const days = Math.round(diffH / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }
}
