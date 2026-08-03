import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';
import { DocxGeneratorService } from '../documents/docx-generator.service';
import { StudentContractsService } from './student-contracts.service';
import { ContractStatus } from '@prisma/client';

describe('StudentContractsService', () => {
  let service: StudentContractsService;
  let prisma: jest.Mocked<PrismaService>;
  let pdfGen: PdfGeneratorService;
  let docxGen: DocxGeneratorService;

  const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
  const CONTRACT_ID = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    prisma = {
      student: {
        findUnique: jest.fn(),
      },
      contract: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    pdfGen = new PdfGeneratorService();
    docxGen = new DocxGeneratorService();
    service = new StudentContractsService(prisma, pdfGen, docxGen);
  });

  describe('createContract', () => {
    it('creates contract successfully', async () => {
      (prisma.student.findUnique as jest.Mock).mockResolvedValue({ id: STUDENT_ID });
      (prisma.contract.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.contract.create as jest.Mock).mockResolvedValue({
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        contractNumber: 'ONT-2026-001',
        title: 'Договор обучения',
        issuedAt: new Date('2026-08-01'),
        validUntil: null,
        status: ContractStatus.ACTIVE,
        notes: null,
        createdAt: new Date('2026-08-01'),
        updatedAt: new Date('2026-08-01'),
      });

      const result = await service.createContract(STUDENT_ID, {
        contractNumber: 'ONT-2026-001',
        title: 'Договор обучения',
        issuedAt: '2026-08-01',
      });

      expect(result.contractNumber).toBe('ONT-2026-001');
    });

    it('throws NotFoundException if student not found', async () => {
      (prisma.student.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createContract(STUDENT_ID, {
          contractNumber: 'ONT-2026-001',
          title: 'Договор обучения',
          issuedAt: '2026-08-01',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException if contract number exists', async () => {
      (prisma.student.findUnique as jest.Mock).mockResolvedValue({ id: STUDENT_ID });
      (prisma.contract.findUnique as jest.Mock).mockResolvedValue({ id: CONTRACT_ID });

      await expect(
        service.createContract(STUDENT_ID, {
          contractNumber: 'ONT-2026-001',
          title: 'Договор обучения',
          issuedAt: '2026-08-01',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('exportContract', () => {
    it('exports contract PDF buffer', async () => {
      (prisma.contract.findFirst as jest.Mock).mockResolvedValue({
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        contractNumber: 'ONT-2026-001',
        title: 'Договор обучения',
        issuedAt: new Date('2026-08-01'),
        validUntil: null,
        status: ContractStatus.ACTIVE,
        notes: null,
        student: {
          firstName: 'Нилуфар',
          lastName: 'Каримова',
          phone: '+992900000000',
          groups: [],
        },
      });

      const buffer = await service.exportContract(STUDENT_ID, CONTRACT_ID, 'pdf');
      expect(Buffer.isBuffer(buffer)).toBe(true);
    });
  });
});
