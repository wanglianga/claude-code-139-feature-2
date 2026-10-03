import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { SpotsModule } from './spots/spots.module';
import { ReservationsModule } from './reservations/reservations.module';
import { OperationsModule } from './operations/operations.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { AppealsModule } from './appeals/appeals.module';
import { SettlementModule } from './settlement/settlement.module';
import { ChargingModule } from './charging/charging.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    SpotsModule,
    ReservationsModule,
    OperationsModule,
    DispatchModule,
    AppealsModule,
    SettlementModule,
    ChargingModule,
  ],
})
export class AppModule {}
