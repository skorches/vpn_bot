import { HttpModule } from '@nestjs/axios';
import { Module, forwardRef } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { XuiController } from './xui.controller';
import { XuiService } from './xui.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10_000,
    }),
    forwardRef(() => TelegramModule),
  ],
  controllers: [XuiController],
  providers: [XuiService],
  exports: [XuiService],
})
export class XuiModule {}
