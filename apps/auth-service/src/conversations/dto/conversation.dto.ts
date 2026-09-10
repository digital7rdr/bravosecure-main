import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString,
  IsUUID, Length,
} from 'class-validator';

export class CreateConversationDto {
  @IsIn(['direct', 'group'])
  kind!: 'direct' | 'group';

  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;

  /** Participant user ids — caller is added automatically as admin. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID(undefined, {each: true})
  memberUserIds!: string[];
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;
}

export class AddMemberDto {
  @IsUUID()
  userId!: string;
}
