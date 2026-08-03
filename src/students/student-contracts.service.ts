import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';
import { DocxGeneratorService } from '../documents/docx-generator.service';
import { ContractDto, CreateContractDto } from './dto';

@Injectable()
export class StudentContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfGenerator: PdfGeneratorService,
    private readonly docxGenerator: DocxGeneratorService,
  ) {}

  async createContract(studentId: string, dto: CreateContractDto): Promise<ContractDto> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
    });
    if (!student) {
      throw new NotFoundException(`Студент с id "${studentId}" не найден`);
    }

    const existing = await this.prisma.contract.findUnique({
      where: { contractNumber: dto.contractNumber },
    });
    if (existing) {
      throw new ConflictException(`Договор с номером "${dto.contractNumber}" уже существует`);
    }

    const contract = await this.prisma.contract.create({
      data: {
        studentId,
        contractNumber: dto.contractNumber,
        title: dto.title,
        issuedAt: new Date(dto.issuedAt),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
        status: dto.status ?? 'ACTIVE',
        notes: dto.notes ?? null,
      },
    });

    return ContractDto.fromEntity(contract);
  }

  async findContracts(studentId: string): Promise<ContractDto[]> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
    });
    if (!student) {
      throw new NotFoundException(`Студент с id "${studentId}" не найден`);
    }

    const contracts = await this.prisma.contract.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    });

    return contracts.map(ContractDto.fromEntity);
  }

  async exportContract(
    studentId: string,
    contractId: string,
    format: 'pdf' | 'docx' = 'pdf',
  ): Promise<Buffer> {
    const contract = await this.prisma.contract.findFirst({
      where: { id: contractId, studentId },
      include: {
        student: {
          include: {
            groups: {
              where: { status: 'ACTIVE' },
              include: { group: { include: { course: true } } },
            },
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Договор с id "${contractId}" у студента "${studentId}" не найден`);
    }

    const activeCourse = contract.student.groups[0]?.group.course.title;

    const data = {
      contractNumber: contract.contractNumber,
      studentName: `${contract.student.firstName} ${contract.student.lastName}`,
      studentPhone: contract.student.phone,
      studentAddress: contract.student.address ?? undefined,
      courseTitle: activeCourse,
      issuedAt: contract.issuedAt,
      validUntil: contract.validUntil ?? undefined,
      notes: contract.notes ?? undefined,
    };

    if (format === 'docx') {
      return this.docxGenerator.generateContractDocx(data);
    }

    return this.pdfGenerator.generateContractPdf(data);
  }
}
