import { Module } from '@nestjs/common';
import { PdfGeneratorService } from './pdf-generator.service';
import { DocxGeneratorService } from './docx-generator.service';

@Module({
  providers: [PdfGeneratorService, DocxGeneratorService],
  exports: [PdfGeneratorService, DocxGeneratorService],
})
export class DocumentsModule {}
