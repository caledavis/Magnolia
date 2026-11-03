# Grouping

The `Grouped by` function is common to several analysis tools. It allows you to conveniently group your results.

## Default state
If the [Document Selector](/guide/documentselector) **does not** target a survey, by default, your results will not be grouped unless you specify otherwise. This means that you will see the results for each individual document.

If the [Document Selector](/guide/documentselector) **does** target a survey, by default, your results will be grouped by respondents. This means that you will see the results for each individual document, with all respondents grouped together for the survey (or surveys).

::: info
The reason for this is simply that if survey results were not grouped by respondent, your results table would consider each respondent's answers to be a document in itself and make a separate column for each survey respondent. The results can then become very long (a survey with 50 respondents, for example, would have a column for each respondent!). If you do want to see each respondent in an individual column, simply remove Respondents from `Grouped by`.
:::

To limit a survey to some of its questions or respondents, choose them in the [Document Selector](/guide/documentselector#survey-questions-and-respondents).
