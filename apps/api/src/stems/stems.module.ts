import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { StemsController } from './stems.controller.js';
import { StemsService } from './stems.service.js';

@Module({
  imports: [StorageModule, SessionsModule],
  controllers: [StemsController],
  providers: [StemsService],
})
export class StemsModule {}
