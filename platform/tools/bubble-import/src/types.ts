/**
 * Bubble Data API shapes — only the fields this import reads. Every field is
 * optional/loose because bubble omits empties and the data is hand-authored.
 */

export interface BubbleQuest {
  _id: string;
  'Created Date'?: string;
  'Modified Date'?: string;
  'Created By'?: string;
  creatorUser?: string;
  Quest_name_ru?: string;
  Shop_name_ru?: string;
  Summary_of_the_quest_ru?: string;
  Preview_image?: string;
  Price?: number;
  Quest_level?: string;
  Age_limit?: string;
  statusQuest?: string;
  Publish_on_the_site?: boolean;
  reviewGrade?: number;
  completedcount?: number;
  theNumberOfUsersWhoCompletedTheQuest?: number;
  questCity?: string;
  questCountry?: string;
  Quest_setting?: string;
  Tags?: string[];
  /** Unordered membership set of page ids; play order comes from Page_number. */
  Page?: string[];
}

export type BubblePageType =
  | 'Start'
  | 'Continue'
  | 'Question'
  | 'QuestionNoAnswer'
  | 'Congratulations'
  | 'Error'
  | null;

export interface BubblePage {
  _id: string;
  'Created Date'?: string;
  'Modified Date'?: string;
  Quest_name?: string; // back-ref to quest _id
  Page_number?: number; // canonical play order
  Page_type?: BubblePageType;
  Page_name_RU?: string;
  Main_text_RU?: string;
  Question_RU?: string;
  Place_RU?: string;
  Duration_RU?: string;
  Button_text_RU?: string;
  Image_link?: string;
  Hint_Image?: string;
  Video_link?: string;
  latitude?: number;
  longitude?: number;
  /** Verbatim acceptable answers (Question pages). May contain the '11' sentinel. */
  Answer?: string[];
}

export interface BubbleUser {
  _id: string;
  'Created Date'?: string;
  username?: string;
  Role?: string;
  authentication?: { email?: { email?: string } };
}

export interface BubbleMeta {
  fetchedAt: string;
  source: string;
  counts: { quests: number; pages: number; authors: number };
}
