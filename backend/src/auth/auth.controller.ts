import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from './auth.guard';
import { AuthService, JwtUser } from './auth.service';
import { DbService } from '../database/db.service';

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private db: DbService,
  ) {}

  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.auth.login(body.username, body.password);
  }

  @Post('register')
  register(
    @Body()
    body: {
      username: string;
      password: string;
      name: string;
      role: 'owner' | 'driver' | 'property' | 'admin';
      phone?: string;
    },
  ) {
    return this.auth.register(body.username, body.password, body.name, body.role, body.phone);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    const { rows } = await this.db.query(
      `SELECT id, username, name, role, phone, credit_score, deposit_balance FROM users WHERE id=$1`,
      [user.sub],
    );
    return rows[0];
  }
}
