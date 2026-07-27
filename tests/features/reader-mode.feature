Feature: Reader mode
  As someone who wants to read an article rather than a page
  I want the text, and nothing that is not the text
  So that reading does not mean scrolling past four columns of other things

  The failure this feature is built around is not "reader mode showed the wrong thing" —
  a reader sees that at once and presses back. It is **three paragraphs of a
  nine-paragraph article**: the text is right, the formatting is right, and the reader
  only finds out at the end, where the piece simply stops. Nothing on the page says so.

  So refusing is a first-class answer here, and it comes with the figure it was decided
  on — eight hundred characters of body text, link text already subtracted — because a
  threshold in a unit a person can argue with is a threshold somebody can disagree with.
  A score in arbitrary points can only be tuned until the pages in front of you pass.

  Scenario: An article is not cut down to its densest section
    Given a page with 9 paragraphs of article text
    And 3 of them sit in a section of their own
    When reader mode reads the page
    Then it presents the article
    And the article keeps all 9 paragraphs
    And the text it judged on is all the article text on the page

  Scenario: An article three wrappers deep is still the article
    Given a page with 9 paragraphs of article text inside 3 nested wrappers
    And a comment thread of 4 paragraphs beside it
    When reader mode reads the page
    Then it presents the article
    And the article keeps all 9 paragraphs
    And the article holds nothing from the comment thread

  Scenario: A cookie notice's worth of prose is not an article
    Given a page with 2 paragraphs of article text
    When reader mode reads the page
    Then it refuses: this does not look like an article
    And it says how much article text it found, and how much it wanted

  Scenario: A column of thirty links is not an article, however much text it holds
    Given a page whose only text is a column of 30 links
    When reader mode reads the page
    Then it refuses: the page holds no article text

  Scenario: A shop category page is not an article
    Given a page with no body copy at all
    When reader mode reads the page
    Then it refuses: the page holds no article text

  Scenario: A page that could only be read in part is refused, article or not
    Given a page with 9 paragraphs of article text
    And the transcription stopped before the end of the page
    When reader mode reads the page
    Then it refuses: the page came back cut short

  Scenario: A page whose answer this build cannot make sense of is refused, not repaired
    Given a page that answered with something this build cannot read
    When reader mode reads the page
    Then it refuses: the answer from the page could not be read
