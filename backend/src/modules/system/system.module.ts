import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SystemController } from './system.controller';

@Module({
  imports: [SettingsModule],
  controllers: [SystemController],
})
export class SystemModule {}
