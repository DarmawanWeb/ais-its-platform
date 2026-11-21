import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { CreateNoteDto } from './dto/create-note.dto.js';
import { ListNotesQuery } from './dto/list-notes.query.js';
import { NoteDto, NotePageDto } from './dto/note.dto.js';
import { UpdateNoteDto } from './dto/update-note.dto.js';
import { NotesService } from './notes.service.js';

/**
 * Vessel notes (example feature): `/api/v2/__SERVICE_NAME__/notes`.
 * Reads need `vessel:read`, writes `vessel:write` (contracts
 * `ROLE_PERMISSIONS`); notes are private to the organization.
 */
@ApiTags('notes')
@Controller('__SERVICE_NAME__/notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post()
  @RequirePermissions('vessel:write')
  @ApiOperation({ summary: 'Create a note in the active organization' })
  @ApiCreatedResponse({ type: NoteDto })
  async create(
    @Body() body: CreateNoteDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<NoteDto> {
    return new NoteDto(await this.notes.create(body, principal, request));
  }

  @Get()
  @RequirePermissions('vessel:read')
  @ApiOperation({ summary: 'List notes, newest first' })
  @ApiOkResponse({ type: NotePageDto })
  async list(
    @Query() query: ListNotesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotePageDto> {
    const { page, pageSize, ...filter } = query;
    return new NotePageDto(
      await this.notes.list(filter, { page, pageSize }, principal),
    );
  }

  @Get(':id')
  @RequirePermissions('vessel:read')
  @ApiOperation({ summary: 'Get a note' })
  @ApiOkResponse({ type: NoteDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NoteDto> {
    return new NoteDto(await this.notes.get(id, principal));
  }

  @Patch(':id')
  @RequirePermissions('vessel:write')
  @ApiOperation({ summary: 'Change the title, body or tags of a note' })
  @ApiOkResponse({ type: NoteDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateNoteDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<NoteDto> {
    return new NoteDto(await this.notes.update(id, body, principal, request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vessel:write')
  @ApiOperation({ summary: 'Delete a note' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.notes.remove(id, principal, request);
  }
}
