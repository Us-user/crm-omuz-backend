import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import type { Response } from 'express';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ContractDto, CreateContractDto } from './dto';
import { StudentContractsService } from './student-contracts.service';

@ApiTags('Students Contracts')
@ApiBearerAuth('access-token')
@Controller('students')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentContractsController {
  constructor(private readonly contractsService: StudentContractsService) {}

  @Post(':id/contracts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Contracts.Create')
  @ApiOperation({ summary: 'Создание договора студента' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор профиля студента' })
  @ApiDataResponse(ContractDto, { description: 'Договор создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  createContract(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContractDto,
  ): Promise<ContractDto> {
    return this.contractsService.createContract(id, dto);
  }

  @Get(':id/contracts')
  @RequirePermission('Permission.Contracts.Views')
  @ApiOperation({ summary: 'Список договоров студента' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор профиля студента' })
  @ApiDataResponse(ContractDto, { description: 'Договоры студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findContracts(@Param('id', ParseUUIDPipe) id: string): Promise<ContractDto[]> {
    return this.contractsService.findContracts(id);
  }

  @Get(':id/contracts/:cid/export')
  @RequirePermission('Permission.Contracts.Export')
  @ApiOperation({ summary: 'Экспорт документа договора в формате PDF или DOCX' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор студента' })
  @ApiParam({ name: 'cid', format: 'uuid', description: 'Идентификатор договора' })
  @ApiQuery({ name: 'format', enum: ['pdf', 'docx'], required: false, default: 'pdf' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async exportContract(
    @Param('id', ParseUUIDPipe) studentId: string,
    @Param('cid', ParseUUIDPipe) contractId: string,
    @Query('format') format: 'pdf' | 'docx' = 'pdf',
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.contractsService.exportContract(studentId, contractId, format);

    if (format === 'docx') {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader('Content-Disposition', `attachment; filename="contract_${contractId}.docx"`);
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="contract_${contractId}.pdf"`);
    }

    res.send(file);
  }
}
