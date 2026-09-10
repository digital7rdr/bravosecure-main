import {IsString, MinLength, MaxLength, IsIn} from 'class-validator';

// Audit Rev2 SEC-02 — `userId` REMOVED. It used to select which account to
// log in, straight from the request body, on an unguarded route. The account
// now comes from the verified access token (@CurrentUser().sub) and nothing
// else; re-adding a body-supplied id here re-opens the hole.
export class TotpVerifyDto {
  @IsString() @MinLength(6) @MaxLength(10)    code!:     string;
  @IsString() @MinLength(1) @MaxLength(128)   deviceId!: string;
  @IsIn(['ios','android','web'])              platform!: string;
}
