import { Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { enforceConversationAccess, getRequestContext } from '../common/request-context';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get('recompute')
  async recompute() {
    const result = await this.conversationsService.recomputeRecent();
    return { status: 'completed', timestamp: new Date().toISOString(), ...result };
  }

  @Get()
  async list(@Req() req: Request, @Query('employee_id') employeeId?: string) {
    const ctx = getRequestContext(req);
    const conversations = await this.conversationsService.getAll({
      companyId: ctx.companyId,
      departmentId: ctx.role === 'HEAD' ? ctx.departmentId : undefined,
      employeeId: ctx.role === 'EMPLOYEE' ? ctx.employeeId : employeeId,
    });
    return { total: conversations.length, conversations };
  }

  @Post(':id/done')
  async markDone(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (row) enforceConversationAccess(ctx, row);
    await this.conversationsService.markAsDone(ctx.companyId, conversationId);
    return { status: 'ok', action: 'marked_done' };
  }

  @Post(':id/mark-done')
  async markDoneAlias(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (row) enforceConversationAccess(ctx, row);
    await this.conversationsService.markAsDone(ctx.companyId, conversationId);
    return { status: 'ok', action: 'marked_done' };
  }

  @Post(':id/ignore')
  async ignore(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (row) enforceConversationAccess(ctx, row);
    await this.conversationsService.ignoreThread(ctx.companyId, conversationId);
    return { status: 'ok', action: 'ignored' };
  }

  @Delete(':id')
  async deleteConversation(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (row) enforceConversationAccess(ctx, row);
    await this.conversationsService.deleteConversation(ctx.companyId, conversationId);
    return { status: 'ok', action: 'deleted' };
  }

  @Post('auto-archive')
  async autoArchive() {
    const count = await this.conversationsService.autoArchiveResolved();
    return { status: 'ok', archived: count };
  }
}
