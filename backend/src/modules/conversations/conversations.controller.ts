import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { enforceConversationAccess, getRequestContext } from '../common/request-context';
import { ConversationsService } from './conversations.service';
import { AuditLogService } from '../common/audit-log.service';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('recompute')
  async recompute(@Req() req: Request) {
    if (!req.internalApiAuth) {
      const ctx = getRequestContext(req);
      if (ctx.role !== 'CEO') {
        throw new ForbiddenException('Only CEO or internal API key can trigger recompute');
      }
    }
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
    if (!row) throw new NotFoundException('Conversation not found');
    enforceConversationAccess(ctx, row);
    const ok = await this.conversationsService.markAsDone(ctx.companyId, conversationId);
    if (!ok) throw new NotFoundException('Conversation not found');
    if (req.user) {
      await this.auditLogService.log({
        userId: req.user.id,
        companyId: ctx.companyId,
        action: 'mark_done',
        entity: 'conversation',
        entityId: conversationId,
      });
    }
    return { status: 'ok', action: 'marked_done' };
  }

  @Post(':id/mark-done')
  async markDoneAlias(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (!row) throw new NotFoundException('Conversation not found');
    enforceConversationAccess(ctx, row);
    const ok = await this.conversationsService.markAsDone(ctx.companyId, conversationId);
    if (!ok) throw new NotFoundException('Conversation not found');
    if (req.user) {
      await this.auditLogService.log({
        userId: req.user.id,
        companyId: ctx.companyId,
        action: 'mark_done',
        entity: 'conversation',
        entityId: conversationId,
      });
    }
    return { status: 'ok', action: 'marked_done' };
  }

  @Post(':id/ignore')
  async ignore(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (!row) throw new NotFoundException('Conversation not found');
    enforceConversationAccess(ctx, row);
    const ok = await this.conversationsService.ignoreThread(ctx.companyId, conversationId);
    if (!ok) throw new NotFoundException('Conversation not found');
    if (req.user) {
      await this.auditLogService.log({
        userId: req.user.id,
        companyId: ctx.companyId,
        action: 'ignore',
        entity: 'conversation',
        entityId: conversationId,
      });
    }
    return { status: 'ok', action: 'ignored' };
  }

  @Delete(':id')
  async deleteConversation(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (!row) throw new NotFoundException('Conversation not found');
    enforceConversationAccess(ctx, row);
    await this.conversationsService.deleteConversation(ctx.companyId, conversationId);
    if (req.user) {
      await this.auditLogService.log({
        userId: req.user.id,
        companyId: ctx.companyId,
        action: 'conversation_deleted',
        entity: 'conversation',
        entityId: conversationId,
      });
    }
    return { status: 'ok', action: 'deleted' };
  }

  @Post(':id/reassign')
  async reassign(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { targetEmployeeId?: string },
  ) {
    const ctx = getRequestContext(req);
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot reassign conversations');
    }

    const targetEmployeeId = body?.targetEmployeeId?.trim();
    if (!targetEmployeeId) {
      throw new BadRequestException('targetEmployeeId is required');
    }

    const conversationId = decodeURIComponent(id);
    const row = await this.conversationsService.getConversationScopeRow(ctx.companyId, conversationId);
    if (!row) throw new NotFoundException('Conversation not found');
    enforceConversationAccess(ctx, row);

    // For HEAD, the target employee must be in the same department
    if (ctx.role === 'HEAD' && ctx.departmentId) {
      const targetDept = await this.conversationsService.getEmployeeDepartment(ctx.companyId, targetEmployeeId);
      if (targetDept !== ctx.departmentId) {
        throw new ForbiddenException('Target employee is not in your department');
      }
    }

    const { newConversationId } = await this.conversationsService.reassignConversation(
      ctx.companyId,
      conversationId,
      targetEmployeeId,
    );

    if (req.user) {
      await this.auditLogService.log({
        userId: req.user.id,
        companyId: ctx.companyId,
        action: 'reassign',
        entity: 'conversation',
        entityId: conversationId,
        metadata: { targetEmployeeId, newConversationId },
      });
    }

    return { status: 'ok', newConversationId };
  }

  @Post('auto-archive')
  async autoArchive(@Req() req: Request) {
    if (!req.internalApiAuth) {
      const ctx = getRequestContext(req);
      if (ctx.role !== 'CEO') {
        throw new ForbiddenException('Only CEO or internal API key can auto-archive');
      }
    }
    const count = await this.conversationsService.autoArchiveResolved();
    return { status: 'ok', archived: count };
  }
}
