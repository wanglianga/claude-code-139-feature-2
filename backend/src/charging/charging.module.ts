import { Module } from '@nestjs/common';
import { ChargingController } from './charging.controller';

@Module({
  controllers: [ChargingController],
})
export class ChargingModule {}
